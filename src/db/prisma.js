
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { env } from '../config/env.js';

let adapter;

const databaseUrl =
  env.NODE_ENV === 'test' ? env.TEST_DATABASE_URL : env.DIRECT_URL;

if (env.NODE_ENV === 'test') {
  if (!env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL não configurada.');
  }

  adapter = new PrismaPg({
    connectionString: env.TEST_DATABASE_URL
  });
} else {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurada.');
  }

  adapter = new PrismaNeon({
    connectionString: env.DATABASE_URL
  });
}

export const prisma = new PrismaClient({ adapter });
