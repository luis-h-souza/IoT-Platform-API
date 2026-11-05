import { z } from 'zod';

const optionalDescriptionSchema = z.string().trim().nullable().optional();
const optionalExternalIdSchema = z.string().trim().min(1).nullable().optional();

export const sectorIdSchema = z.uuid();

export const createSectorSchema = z
  .object({
    storeId: sectorIdSchema,
    name: z.string().trim().min(1),
    description: optionalDescriptionSchema,
    parentId: sectorIdSchema.nullable().optional(),
    externalId: optionalExternalIdSchema
  })
  .strict();

export const updateSectorSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: optionalDescriptionSchema,
    parentId: sectorIdSchema.nullable().optional(),
    externalId: optionalExternalIdSchema
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Informe ao menos um campo para atualizar.'
  });
