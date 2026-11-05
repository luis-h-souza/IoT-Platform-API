import { ServiceError } from '../../shared/errors/service-error.js';
import { createSectorSchema, sectorIdSchema, updateSectorSchema } from './sector.schema.js';

function throwSectorWriteError(error) {
  if (error?.code === 'P2002') {
    throw new ServiceError('SECTOR_EXTERNAL_ID_CONFLICT', 'O setor já possui esse identificador externo nesta loja.', 409);
  }

  if (error?.code === 'P2025') {
    throw new ServiceError('SECTOR_NOT_FOUND', 'Setor não encontrado.', 404);
  }

  if (error?.code === 'P2003') {
    throw new ServiceError('SECTOR_REFERENCE_NOT_FOUND', 'A loja ou o setor pai não foi encontrado.', 404);
  }

  if (error?.code === 'P2034') {
    throw new ServiceError(
      'SECTOR_HIERARCHY_CONFLICT',
      'A hierarquia foi alterada simultaneamente. Recarregue o setor e tente novamente.',
      409
    );
  }

  throw error;
}

async function requireStore(prisma, storeId) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });

  if (!store) {
    throw new ServiceError('STORE_NOT_FOUND', 'Loja não encontrada.', 404);
  }
}

async function requireParentChain(prisma, { parentId, storeId, sectorId }) {
  if (parentId === null || parentId === undefined) {
    return;
  }

  let parent = await prisma.sector.findUnique({
    where: { id: parentId },
    select: { id: true, storeId: true, parentId: true }
  });

  if (!parent) {
    throw new ServiceError('PARENT_SECTOR_NOT_FOUND', 'Setor pai não encontrado.', 404);
  }

  if (parent.storeId !== storeId) {
    throw new ServiceError('PARENT_SECTOR_STORE_MISMATCH', 'O setor pai deve pertencer à mesma loja.', 409);
  }

  const visited = new Set();

  while (parent) {
    if (parent.id === sectorId || visited.has(parent.id)) {
      throw new ServiceError('SECTOR_HIERARCHY_CYCLE', 'A hierarquia de setores não pode conter ciclos.', 409);
    }

    visited.add(parent.id);

    if (!parent.parentId) {
      return;
    }

    parent = await prisma.sector.findUnique({
      where: { id: parent.parentId },
      select: { id: true, storeId: true, parentId: true }
    });

    if (!parent) {
      throw new ServiceError('SECTOR_HIERARCHY_INVALID', 'A hierarquia existente contém uma referência inválida.', 409);
    }

    if (parent.storeId !== storeId) {
      throw new ServiceError('PARENT_SECTOR_STORE_MISMATCH', 'O setor pai deve pertencer à mesma loja.', 409);
    }
  }
}

export function createSectorService(prisma) {
  if (!prisma?.store || !prisma?.sector) {
    throw new TypeError('A Prisma Client instance deve ser fornecida.');
  }

  return Object.freeze({
    async create(input) {
      const data = createSectorSchema.parse(input);

      try {
        return await prisma.$transaction(
          async (transaction) => {
            await requireStore(transaction, data.storeId);
            await requireParentChain(transaction, { parentId: data.parentId, storeId: data.storeId });

            return transaction.sector.create({ data });
          },
          { isolationLevel: 'Serializable' }
        );
      } catch (error) {
        throwSectorWriteError(error);
      }
    },

    async listByStore(storeId) {
      const validStoreId = sectorIdSchema.parse(storeId);
      await requireStore(prisma, validStoreId);

      return prisma.sector.findMany({
        where: { storeId: validStoreId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }]
      });
    },

    async findById(id) {
      const validId = sectorIdSchema.parse(id);
      const sector = await prisma.sector.findUnique({ where: { id: validId } });

      if (!sector) {
        throw new ServiceError('SECTOR_NOT_FOUND', 'Setor não encontrado.', 404);
      }

      return sector;
    },

    async update(id, input) {
      const validId = sectorIdSchema.parse(id);
      const data = updateSectorSchema.parse(input);

      try {
        if (Object.hasOwn(data, 'parentId')) {
          return await prisma.$transaction(
            async (transaction) => {
              const sector = await transaction.sector.findUnique({
                where: { id: validId },
                select: { id: true, storeId: true }
              });

              if (!sector) {
                throw new ServiceError('SECTOR_NOT_FOUND', 'Setor não encontrado.', 404);
              }

              await requireParentChain(transaction, {
                parentId: data.parentId,
                storeId: sector.storeId,
                sectorId: sector.id
              });

              return transaction.sector.update({ where: { id: validId }, data });
            },
            { isolationLevel: 'Serializable' }
          );
        }

        return await prisma.sector.update({ where: { id: validId }, data });
      } catch (error) {
        throwSectorWriteError(error);
      }
    }
  });
}
