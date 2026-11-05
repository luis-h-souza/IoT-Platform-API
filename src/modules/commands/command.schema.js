import { z } from 'zod';
import { CommandStatus } from '../../generated/prisma/enums.ts';

export const commandIdSchema = z.uuid();
export const commandDeviceIdSchema = z.uuid();

const expiresAtSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const lightingCommandPayloadSchema = z
  .object({
    state: z.enum(['ON', 'OFF'])
  })
  .strict();

export const createDeviceCommandSchema = z
  .object({
    deviceId: commandDeviceIdSchema,
    commandType: z.literal('LIGHTING_SET'),
    payload: lightingCommandPayloadSchema,
    idempotencyKey: z.string().trim().min(1).max(255),
    expiresAt: expiresAtSchema,
    requestedBy: z.string().trim().min(1).nullable().optional()
  })
  .strict();

export const pollDeviceCommandsSchema = z
  .object({
    deviceId: commandDeviceIdSchema,
    limit: z.number().int().min(1).max(50).default(10)
  })
  .strict();

export const acknowledgeDeviceCommandSchema = z
  .object({
    commandId: commandIdSchema,
    deviceId: commandDeviceIdSchema
  })
  .strict();

export const completeDeviceCommandSchema = z
  .object({
    commandId: commandIdSchema,
    deviceId: commandDeviceIdSchema,
    status: z.enum([CommandStatus.SUCCEEDED, CommandStatus.FAILED]),
    result: z.record(z.string(), z.unknown()).nullable().optional(),
    errorCode: z.string().trim().min(1).max(128).nullable().optional()
  })
  .strict()
  .refine(
    ({ status, errorCode }) =>
      status !== CommandStatus.FAILED || Boolean(errorCode),
    { message: 'errorCode é obrigatório quando o comando falha.', path: ['errorCode'] }
  );

export const commandStatusSchema = z.enum(CommandStatus);
