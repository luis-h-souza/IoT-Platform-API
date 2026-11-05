import { z } from 'zod';
import { commandIdSchema } from '../commands/command.schema.js';

export const eventDeviceIdSchema = z.uuid();
export const eventIdSchema = z.string().trim().min(1).max(128);

const occurredAtSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const jsonObjectSchema = z.record(z.string(), z.unknown());

const eventEnvelope = {
  eventId: eventIdSchema,
  occurredAt: occurredAtSchema
};

export const deviceEventSchema = z.discriminatedUnion('eventType', [
  z
    .object({
      ...eventEnvelope,
      eventType: z.literal('HEARTBEAT'),
      payload: z.object({ firmwareVersion: z.string().trim().min(1).optional() }).strict().optional()
    })
    .strict(),
  z
    .object({
      ...eventEnvelope,
      eventType: z.literal('STATE_REPORTED'),
      payload: z
        .object({
          state: z.enum(['ON', 'OFF']),
          commandId: commandIdSchema.optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelope,
      eventType: z.literal('COMMAND_ACKNOWLEDGED'),
      payload: z.object({ commandId: commandIdSchema }).strict()
    })
    .strict(),
  z
    .object({
      ...eventEnvelope,
      eventType: z.literal('COMMAND_RESULT'),
      payload: z
        .object({
          commandId: commandIdSchema,
          status: z.enum(['SUCCEEDED', 'FAILED']),
          actualState: z.enum(['ON', 'OFF']).optional(),
          result: jsonObjectSchema.optional(),
          errorCode: z.string().trim().min(1).max(128).optional()
        })
        .strict()
        .refine(
          ({ status, errorCode }) => status !== 'FAILED' || Boolean(errorCode),
          { message: 'errorCode é obrigatório quando o comando falha.', path: ['errorCode'] }
        )
        .refine(
          ({ actualState, result }) =>
            actualState === undefined ||
            result?.actualState === undefined ||
            actualState === result.actualState,
          {
            message: 'actualState deve ser consistente nos campos do resultado.',
            path: ['result', 'actualState']
          }
        )
    })
    .strict()
]);

export const listDeviceEventsSchema = z
  .object({
    deviceId: eventDeviceIdSchema,
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
