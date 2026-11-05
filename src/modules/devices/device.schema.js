import { z } from 'zod';
import { DeviceFunction, DeviceStatus } from '../../generated/prisma/enums.ts';
import { sectorIdSchema } from '../sectors/sector.schema.js';

const optionalFirmwareVersionSchema = z.string().trim().min(1).nullable().optional();

export const deviceIdSchema = z.uuid();

export const createDeviceSchema = z
  .object({
    deviceUid: z.string().trim().min(1),
    name: z.string().trim().min(1),
    function: z.enum(DeviceFunction),
    firmwareVersion: optionalFirmwareVersionSchema,
    sectorId: sectorIdSchema
  })
  .strict();

export const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    function: z.enum(DeviceFunction).optional(),
    firmwareVersion: optionalFirmwareVersionSchema,
    sectorId: sectorIdSchema.optional(),
    status: z.enum(DeviceStatus).optional()
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Informe ao menos um campo para atualizar.'
  });
