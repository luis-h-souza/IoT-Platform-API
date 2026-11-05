import { z } from 'zod';

const optionalExternalIdSchema = z.string().trim().min(1).nullable().optional();

export const idSchema = z.uuid();

export const createStoreSchema = z
  .object({
    name: z.string().trim().min(1),
    externalId: optionalExternalIdSchema
  })
  .strict();

export const updateStoreSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    externalId: optionalExternalIdSchema
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Informe ao menos um campo para atualizar.'
  });
