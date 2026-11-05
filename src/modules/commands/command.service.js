import { isDeepStrictEqual } from 'node:util';
import { CommandStatus, DeviceStatus } from '../../generated/prisma/enums.ts';
import { ServiceError } from '../../shared/errors/service-error.js';
import {
  acknowledgeDeviceCommandSchema,
  commandDeviceIdSchema,
  commandIdSchema,
  completeDeviceCommandSchema,
  createDeviceCommandSchema,
  pollDeviceCommandsSchema
} from './command.schema.js';
import { expireDueCommands, transitionDeviceCommand } from './command.transitions.js';

export const COMMAND_REDELIVERY_INTERVAL_MS = 30_000;
export const COMMAND_RESULT_MAX_BYTES = 16 * 1024;

function normalizeResult(result) {
  if (result === undefined || result === null) {
    return result;
  }

  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new ServiceError('DEVICE_COMMAND_RESULT_INVALID', 'O resultado deve conter JSON válido.', 422);
  }

  if (typeof serialized !== 'string') {
    throw new ServiceError('DEVICE_COMMAND_RESULT_INVALID', 'O resultado deve conter JSON válido.', 422);
  }

  if (Buffer.byteLength(serialized) > COMMAND_RESULT_MAX_BYTES) {
    throw new ServiceError('DEVICE_COMMAND_RESULT_TOO_LARGE', 'O resultado excede o limite permitido.', 413);
  }

  return JSON.parse(serialized);
}

function idempotentIntentMatches(command, input) {
  return (
    command.deviceId === input.deviceId &&
    command.commandType === input.commandType &&
    isDeepStrictEqual(command.payload, input.payload) &&
    command.expiresAt.getTime() === input.expiresAt.getTime()
  );
}

function throwIdempotencyConflict() {
  throw new ServiceError(
    'DEVICE_COMMAND_IDEMPOTENCY_CONFLICT',
    'A chave de idempotência já foi usada com outra intenção.',
    409
  );
}

async function findByIdempotencyKey(prisma, { deviceId, idempotencyKey }) {
  return prisma.deviceCommand.findUnique({
    where: { deviceId_idempotencyKey: { deviceId, idempotencyKey } }
  });
}

async function returnIdempotentCommand(prisma, input) {
  const existing = await findByIdempotencyKey(prisma, input);

  if (!existing) {
    return null;
  }

  if (!idempotentIntentMatches(existing, input)) {
    throwIdempotencyConflict();
  }

  return existing;
}

export function createDeviceCommandService(prisma, { now = () => new Date() } = {}) {
  if (!prisma?.deviceCommand || !prisma?.device) {
    throw new TypeError('A Prisma Client instance deve ser fornecida.');
  }

  return Object.freeze({
    async create(input) {
      const data = createDeviceCommandSchema.parse(input);

      if (data.expiresAt <= now()) {
        throw new ServiceError(
          'DEVICE_COMMAND_EXPIRATION_INVALID',
          'A expiração do comando deve estar no futuro.',
          422
        );
      }

      const existing = await returnIdempotentCommand(prisma, data);
      if (existing) {
        return existing;
      }

      const device = await prisma.device.findUnique({
        where: { id: data.deviceId },
        select: { id: true }
      });

      if (!device) {
        throw new ServiceError('DEVICE_NOT_FOUND', 'Dispositivo não encontrado.', 404);
      }

      try {
        return await prisma.deviceCommand.create({ data });
      } catch (error) {
        if (error?.code === 'P2002') {
          const concurrentCommand = await returnIdempotentCommand(prisma, data);
          if (concurrentCommand) {
            return concurrentCommand;
          }
        }

        if (error?.code === 'P2003') {
          throw new ServiceError('DEVICE_NOT_FOUND', 'Dispositivo não encontrado.', 404);
        }

        throw error;
      }
    },

    async claimForPolling(deviceId, options = {}) {
      const { deviceId: validDeviceId, limit } = pollDeviceCommandsSchema.parse({
        deviceId,
        limit: options.limit
      });

      return prisma.$transaction(
        async (transaction) => {
          await expireDueCommands(transaction, validDeviceId);

          const claimed = await transaction.$queryRaw`
            WITH candidates AS (
              SELECT command."id"
              FROM "device_commands" AS command
              INNER JOIN "devices" AS device
                ON device."id" = command."deviceId"
               AND device."status" = ${DeviceStatus.ACTIVE}::"DeviceStatus"
              WHERE command."deviceId" = ${validDeviceId}::uuid
                AND command."expiresAt" > clock_timestamp()
                AND (
                  command."status" = ${CommandStatus.QUEUED}::"CommandStatus"
                  OR (
                    command."status" = ${CommandStatus.DELIVERED}::"CommandStatus"
                    AND command."deliveredAt" <= clock_timestamp() - (${COMMAND_REDELIVERY_INTERVAL_MS} * INTERVAL '1 millisecond')
                  )
                )
              ORDER BY command."createdAt" ASC, command."id" ASC
              LIMIT ${limit}
              FOR UPDATE OF command SKIP LOCKED
            )
            UPDATE "device_commands" AS command
            SET "status" = ${CommandStatus.DELIVERED}::"CommandStatus",
                "deliveredAt" = clock_timestamp(),
                "attempts" = command."attempts" + 1,
                "updatedAt" = clock_timestamp()
            FROM candidates
            WHERE command."id" = candidates."id"
            RETURNING command."id" AS "id"
          `;

          if (claimed.length === 0) {
            return [];
          }

          return transaction.deviceCommand.findMany({
            where: { id: { in: claimed.map(({ id }) => id) } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
          });
        },
        { isolationLevel: 'ReadCommitted' }
      );
    },

    async acknowledge(input) {
      const data = acknowledgeDeviceCommandSchema.parse(input);
      const outcome = await prisma.$transaction((transaction) =>
        transitionDeviceCommand(transaction, {
          ...data,
          targetStatus: CommandStatus.ACKNOWLEDGED
        })
      );

      return outcome.command;
    },

    async complete(input) {
      const data = completeDeviceCommandSchema.parse(input);
      data.result = normalizeResult(data.result);
      const outcome = await prisma.$transaction((transaction) =>
        transitionDeviceCommand(transaction, { ...data, targetStatus: data.status })
      );

      if (outcome.terminal && !outcome.sameResult) {
        throw new ServiceError(
          'DEVICE_COMMAND_TERMINAL',
          'O comando já está em um estado terminal e não pode ser substituído.',
          409
        );
      }

      return outcome.command;
    },

    async expireDue(deviceId) {
      const validDeviceId = commandDeviceIdSchema.parse(deviceId);
      return prisma.$transaction((transaction) =>
        expireDueCommands(transaction, validDeviceId)
      );
    },

    async findById(commandId, deviceId) {
      const validCommandId = commandIdSchema.parse(commandId);
      const validDeviceId = commandDeviceIdSchema.parse(deviceId);
      const command = await prisma.deviceCommand.findUnique({
        where: { id: validCommandId }
      });

      if (!command || command.deviceId !== validDeviceId) {
        throw new ServiceError('DEVICE_COMMAND_NOT_FOUND', 'Comando não encontrado para este dispositivo.', 404);
      }

      return command;
    }
  });
}
