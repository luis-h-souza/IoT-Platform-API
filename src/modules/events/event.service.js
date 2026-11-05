import { isDeepStrictEqual } from 'node:util';
import { CommandStatus } from '../../generated/prisma/enums.ts';
import { ServiceError } from '../../shared/errors/service-error.js';
import { transitionDeviceCommand } from '../commands/command.transitions.js';
import { eventDeviceIdSchema, deviceEventSchema, listDeviceEventsSchema } from './event.schema.js';

export const EVENT_MAX_FUTURE_SKEW_MS = 5 * 60_000;
export const DEVICE_EVENT_MAX_PAYLOAD_BYTES = 16 * 1024;

function jsonValue(value) {
  if (value === undefined) {
    return null;
  }

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ServiceError('DEVICE_EVENT_PAYLOAD_INVALID', 'O payload do evento deve ser JSON válido.', 422);
  }

  if (typeof serialized !== 'string') {
    throw new ServiceError('DEVICE_EVENT_PAYLOAD_INVALID', 'O payload do evento deve ser JSON válido.', 422);
  }

  if (Buffer.byteLength(serialized) > DEVICE_EVENT_MAX_PAYLOAD_BYTES) {
    throw new ServiceError('DEVICE_EVENT_PAYLOAD_TOO_LARGE', 'O payload do evento excede o limite permitido.', 413);
  }

  return JSON.parse(serialized);
}

function sameEvent(existing, event) {
  return (
    existing.eventType === event.eventType &&
    existing.occurredAt.getTime() === event.occurredAt.getTime() &&
    isDeepStrictEqual(existing.payload ?? null, event.payload ?? null)
  );
}

function throwDuplicateEventConflict() {
  throw new ServiceError(
    'DEVICE_EVENT_ID_CONFLICT',
    'O eventId já foi utilizado com conteúdo diferente para este dispositivo.',
    409
  );
}

function getCommandReference(event) {
  if (
    event.eventType === 'COMMAND_ACKNOWLEDGED' ||
    event.eventType === 'COMMAND_RESULT'
  ) {
    return event.payload.commandId;
  }

  if (event.eventType === 'STATE_REPORTED') {
    return event.payload.commandId;
  }

  return undefined;
}

function commandTransitionForEvent(transaction, deviceId, event) {
  if (event.eventType === 'COMMAND_ACKNOWLEDGED') {
    return transitionDeviceCommand(transaction, {
      commandId: event.payload.commandId,
      deviceId,
      targetStatus: CommandStatus.ACKNOWLEDGED
    });
  }

  if (event.eventType === 'COMMAND_RESULT') {
    const result = {
      ...(event.payload.result ?? {}),
      ...(event.payload.actualState ? { actualState: event.payload.actualState } : {})
    };

    return transitionDeviceCommand(transaction, {
      commandId: event.payload.commandId,
      deviceId,
      targetStatus: event.payload.status,
      result: Object.keys(result).length > 0 ? result : null,
      errorCode: event.payload.errorCode ?? null
    });
  }

  return null;
}

export function createDeviceEventService(
  prisma,
  { now = () => new Date(), futureSkewMs = EVENT_MAX_FUTURE_SKEW_MS } = {}
) {
  if (!prisma?.deviceEvent || !prisma?.device) {
    throw new TypeError('A Prisma Client instance deve ser fornecida.');
  }

  return Object.freeze({
    async ingest(deviceId, input) {
      const validDeviceId = eventDeviceIdSchema.parse(deviceId);
      const event = deviceEventSchema.parse(input);
      const payload = jsonValue(event.payload);

      if (event.occurredAt.getTime() > now().getTime() + futureSkewMs) {
        throw new ServiceError(
          'DEVICE_EVENT_TIMESTAMP_IN_FUTURE',
          'O horário de ocorrência excede a tolerância de relógio do dispositivo.',
          422
        );
      }

      const existingEvent = await prisma.deviceEvent.findUnique({
        where: {
          deviceId_eventId: {
            deviceId: validDeviceId,
            eventId: event.eventId
          }
        }
      });

      if (existingEvent) {
        if (!sameEvent(existingEvent, { ...event, payload })) {
          throwDuplicateEventConflict();
        }

        return { event: existingEvent, duplicate: true, command: null };
      }

      const commandId = getCommandReference(event);

      try {
        return await prisma.$transaction(
          async (transaction) => {
            const device = await transaction.device.findUnique({
              where: { id: validDeviceId },
              select: { id: true }
            });

            if (!device) {
              throw new ServiceError('DEVICE_NOT_FOUND', 'Dispositivo não encontrado.', 404);
            }

            if (commandId) {
              const command = await transaction.deviceCommand.findUnique({
                where: { id: commandId },
                select: { id: true, deviceId: true }
              });

              if (!command || command.deviceId !== validDeviceId) {
                throw new ServiceError(
                  'DEVICE_COMMAND_NOT_FOUND',
                  'Comando não encontrado para este dispositivo.',
                  404
                );
              }
            }

            const savedEvent = await transaction.deviceEvent.create({
              data: {
                deviceId: validDeviceId,
                eventId: event.eventId,
                eventType: event.eventType,
                payload,
                occurredAt: event.occurredAt
              }
            });

            const command = await commandTransitionForEvent(
              transaction,
              validDeviceId,
              { ...event, payload }
            );

            await transaction.device.updateMany({
              where: {
                id: validDeviceId,
                OR: [
                  { lastSeenAt: null },
                  { lastSeenAt: { lt: savedEvent.receivedAt } }
                ]
              },
              data: { lastSeenAt: savedEvent.receivedAt }
            });

            return { event: savedEvent, duplicate: false, command: command?.command ?? null };
          },
          { isolationLevel: 'ReadCommitted' }
        );
      } catch (error) {
        if (error?.code !== 'P2002') {
          throw error;
        }

        const concurrentEvent = await prisma.deviceEvent.findUnique({
          where: {
            deviceId_eventId: {
              deviceId: validDeviceId,
              eventId: event.eventId
            }
          }
        });

        if (!concurrentEvent) {
          throw error;
        }

        if (!sameEvent(concurrentEvent, { ...event, payload })) {
          throwDuplicateEventConflict();
        }

        return { event: concurrentEvent, duplicate: true, command: null };
      }
    },

    async listByDevice(deviceId, options = {}) {
      const { deviceId: validDeviceId, limit } = listDeviceEventsSchema.parse({
        deviceId,
        limit: options.limit
      });
      const device = await prisma.device.findUnique({
        where: { id: validDeviceId },
        select: { id: true }
      });

      if (!device) {
        throw new ServiceError('DEVICE_NOT_FOUND', 'Dispositivo não encontrado.', 404);
      }

      // Ordena pelo recebimento da API; isso não declara qual estado físico atual é verdadeiro.
      return prisma.deviceEvent.findMany({
        where: { deviceId: validDeviceId },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: limit
      });
    }
  });
}
