import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '../generated/prisma/client.ts';
import { env } from '../config/env.js';

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada.');
}

const adapter = new PrismaNeon({
  connectionString: env.DATABASE_URL
});

export const prisma = new PrismaClient({
  adapter
});
