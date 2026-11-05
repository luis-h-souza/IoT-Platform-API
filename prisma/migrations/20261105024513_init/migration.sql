-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DeviceFunction" AS ENUM ('LIGHTING');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('QUEUED', 'DELIVERED', 'ACKNOWLEDGED', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "stores" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sectors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "storeId" UUID NOT NULL,
    "parentId" UUID,
    "externalId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "deviceUid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "function" "DeviceFunction" NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PROVISIONING',
    "firmwareVersion" TEXT,
    "sectorId" UUID NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_events" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_commands" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "commandType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT,
    "requestedBy" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "deliveredAt" TIMESTAMPTZ(3),
    "acknowledgedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "result" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stores_externalId_key" ON "stores"("externalId");

-- CreateIndex
CREATE INDEX "sectors_storeId_parentId_idx" ON "sectors"("storeId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "sectors_storeId_externalId_key" ON "sectors"("storeId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "devices_deviceUid_key" ON "devices"("deviceUid");

-- CreateIndex
CREATE INDEX "devices_sectorId_status_idx" ON "devices"("sectorId", "status");

-- CreateIndex
CREATE INDEX "device_events_deviceId_receivedAt_idx" ON "device_events"("deviceId", "receivedAt");

-- CreateIndex
CREATE INDEX "device_events_eventType_receivedAt_idx" ON "device_events"("eventType", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "device_events_deviceId_eventId_key" ON "device_events"("deviceId", "eventId");

-- CreateIndex
CREATE INDEX "device_commands_deviceId_status_createdAt_idx" ON "device_commands"("deviceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "device_commands_status_expiresAt_idx" ON "device_commands"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "device_commands_deviceId_idempotencyKey_key" ON "device_commands"("deviceId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "sectors" ADD CONSTRAINT "sectors_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sectors" ADD CONSTRAINT "sectors_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "sectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "sectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
