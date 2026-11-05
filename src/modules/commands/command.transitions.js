import { isDeepStrictEqual } from 'node:util';
import { CommandStatus } from '../../generated/prisma/enums.ts';
import { ServiceError } from '../../shared/errors/service-error.js';

export async function expireDueCommands(transaction, deviceId) {
  return transaction.$executeRaw`
    UPDATE "device_commands"
    SET "status" = 'EXPIRED'::"CommandStatus",
        "completedAt" = clock_timestamp(),
        "updatedAt" = clock_timestamp()
    WHERE "deviceId" = ${deviceId}::uuid
      AND "status" IN ('QUEUED'::"CommandStatus", 'DELIVERED'::"CommandStatus", 'ACKNOWLEDGED'::"CommandStatus")
      AND "expiresAt" <= clock_timestamp()
  `;
}

async function findCurrentCommand(transaction, commandId, deviceId) {
  await transaction.$executeRaw`
    UPDATE "device_commands"
    SET "status" = 'EXPIRED'::"CommandStatus",
        "completedAt" = clock_timestamp(),
        "updatedAt" = clock_timestamp()
    WHERE "id" = ${commandId}::uuid
      AND "deviceId" = ${deviceId}::uuid
      AND "status" IN ('QUEUED'::"CommandStatus", 'DELIVERED'::"CommandStatus", 'ACKNOWLEDGED'::"CommandStatus")
      AND "expiresAt" <= clock_timestamp()
  `;

  return transaction.deviceCommand.findUnique({ where: { id: commandId } });
}

export async function transitionDeviceCommand(
  transaction,
  { commandId, deviceId, targetStatus, result, errorCode }
) {
  let command = await findCurrentCommand(transaction, commandId, deviceId);

  if (!command || command.deviceId !== deviceId) {
    throw new ServiceError('DEVICE_COMMAND_NOT_FOUND', 'Comando não encontrado para este dispositivo.', 404);
  }

  if (command.status === CommandStatus.EXPIRED) {
    return { command, applied: false, terminal: true };
  }

  if (
    command.status === CommandStatus.SUCCEEDED ||
    command.status === CommandStatus.FAILED
  ) {
    const sameResult =
      command.status === targetStatus &&
      (targetStatus === CommandStatus.ACKNOWLEDGED ||
        (isDeepStrictEqual(command.result, result ?? null) &&
          command.errorCode === (errorCode ?? null)));

    return { command, applied: false, terminal: true, sameResult };
  }

  if (targetStatus === CommandStatus.ACKNOWLEDGED) {
    if (command.status === CommandStatus.ACKNOWLEDGED) {
      return { command, applied: false, terminal: false, sameResult: true };
    }

    if (command.status !== CommandStatus.DELIVERED) {
      throw new ServiceError(
        'DEVICE_COMMAND_INVALID_TRANSITION',
        'O comando precisa estar entregue antes da confirmação do dispositivo.',
        409
      );
    }

    const updated = await transaction.$queryRaw`
      UPDATE "device_commands"
      SET "status" = 'ACKNOWLEDGED'::"CommandStatus",
          "acknowledgedAt" = clock_timestamp(),
          "updatedAt" = clock_timestamp()
      WHERE "id" = ${commandId}::uuid
        AND "deviceId" = ${deviceId}::uuid
        AND "status" = 'DELIVERED'::"CommandStatus"
        AND "expiresAt" > clock_timestamp()
      RETURNING "id"
    `;

    if (updated.length === 0) {
      command = await findCurrentCommand(transaction, commandId, deviceId);
      return {
        command,
        applied: false,
        terminal: command?.status !== CommandStatus.ACKNOWLEDGED,
        sameResult: command?.status === CommandStatus.ACKNOWLEDGED
      };
    }

    command = await transaction.deviceCommand.findUnique({ where: { id: commandId } });
    return { command, applied: true, terminal: false };
  }

  if (command.status !== CommandStatus.ACKNOWLEDGED) {
    throw new ServiceError(
      'DEVICE_COMMAND_INVALID_TRANSITION',
      'O comando precisa ser confirmado antes do resultado de execução.',
      409
    );
  }

  const resultJson = result === undefined ? null : JSON.stringify(result);
  const updated = await transaction.$queryRaw`
    UPDATE "device_commands"
    SET "status" = ${targetStatus}::"CommandStatus",
        "result" = ${resultJson}::jsonb,
        "errorCode" = ${errorCode ?? null},
        "completedAt" = clock_timestamp(),
        "updatedAt" = clock_timestamp()
    WHERE "id" = ${commandId}::uuid
      AND "deviceId" = ${deviceId}::uuid
      AND "status" = 'ACKNOWLEDGED'::"CommandStatus"
      AND "expiresAt" > clock_timestamp()
    RETURNING "id"
  `;

  if (updated.length === 0) {
    command = await findCurrentCommand(transaction, commandId, deviceId);
    const sameResult =
      command?.status === targetStatus &&
      isDeepStrictEqual(command.result, result ?? null) &&
      command.errorCode === (errorCode ?? null);

    return {
      command,
      applied: false,
      terminal: command?.status !== CommandStatus.ACKNOWLEDGED,
      sameResult
    };
  }

  command = await transaction.deviceCommand.findUnique({ where: { id: commandId } });
  return { command, applied: true, terminal: false };
}
