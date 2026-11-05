import { ServiceError } from '../../shared/errors/service-error.js';
import { sectorIdSchema } from '../sectors/sector.schema.js';
import { createDeviceSchema, deviceIdSchema, updateDeviceSchema } from './device.schema.js';

function throwDeviceWriteError(error) {
  if (error?.code === 'P2002') {
    throw new ServiceError('DEVICE_UID_CONFLICT', 'Já existe um dispositivo com esse UID.', 409);
  }

  if (error?.code === 'P2025') {
    throw new ServiceError('DEVICE_NOT_FOUND', 'Dispositivo não encontrado.', 404);
  }

  if (error?.code === 'P2003') {
    throw new ServiceError('SECTOR_NOT_FOUND', 'Setor não encontrado.', 404);
  }

  throw error;
}

async function requireSector(prisma, sectorId) {
  const sector = await prisma.sector.findUnique({ where: { id: sectorId }, select: { id: true } });

  if (!sector) {
    throw new ServiceError('SECTOR_NOT_FOUND', 'Setor não encontrado.', 404);
  }
}

export function createDeviceService(prisma) {
  if (!prisma?.device || !prisma?.sector) {
    throw new TypeError('A Prisma Client instance deve ser fornecida.');
  }

  return Object.freeze({
    async create(input) {
      const data = createDeviceSchema.parse(input);
      await requireSector(prisma, data.sectorId);

      try {
        return await prisma.device.create({ data });
      } catch (error) {
        throwDeviceWriteError(error);
      }
    },

    async listBySector(sectorId) {
      const validSectorId = sectorIdSchema.parse(sectorId);
      await requireSector(prisma, validSectorId);

      return prisma.device.findMany({
        where: { sectorId: validSectorId },
        orderBy: [{ deviceUid: 'asc' }, { id: 'asc' }]
      });
    },

    async findById(id) {
      const validId = deviceIdSchema.parse(id);
      const device = await prisma.device.findUnique({ where: { id: validId } });

      if (!device) {
        throw new ServiceError('DEVICE_NOT_FOUND', 'Dispositivo não encontrado.', 404);
      }

      return device;
    },

    async update(id, input) {
      const validId = deviceIdSchema.parse(id);
      const data = updateDeviceSchema.parse(input);

      try {
        if (Object.hasOwn(data, 'sectorId')) {
          await requireSector(prisma, data.sectorId);
        }

        return await prisma.device.update({ where: { id: validId }, data });
      } catch (error) {
        throwDeviceWriteError(error);
      }
    }
  });
}
