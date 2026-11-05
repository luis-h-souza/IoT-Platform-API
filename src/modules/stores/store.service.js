import { ServiceError } from '../../shared/errors/service-error.js';
import { createStoreSchema, idSchema, updateStoreSchema } from './store.schema.js';

function throwStoreConflict(error) {
  if (error?.code === 'P2002') {
    throw new ServiceError('STORE_EXTERNAL_ID_CONFLICT', 'A loja já possui esse identificador externo.', 409);
  }

  if (error?.code === 'P2025') {
    throw new ServiceError('STORE_NOT_FOUND', 'Loja não encontrada.', 404);
  }

  throw error;
}

export function createStoreService(prisma) {
  if (!prisma?.store) {
    throw new TypeError('A Prisma Client instance deve ser fornecida.');
  }

  return Object.freeze({
    async create(input) {
      const data = createStoreSchema.parse(input);

      try {
        return await prisma.store.create({ data });
      } catch (error) {
        throwStoreConflict(error);
      }
    },

    list() {
      return prisma.store.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    },

    async findById(id) {
      const validId = idSchema.parse(id);
      const store = await prisma.store.findUnique({ where: { id: validId } });

      if (!store) {
        throw new ServiceError('STORE_NOT_FOUND', 'Loja não encontrada.', 404);
      }

      return store;
    },

    async update(id, input) {
      const validId = idSchema.parse(id);
      const data = updateStoreSchema.parse(input);

      try {
        return await prisma.store.update({ where: { id: validId }, data });
      } catch (error) {
        throwStoreConflict(error);
      }
    }
  });
}
