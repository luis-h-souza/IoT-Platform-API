import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { env } from './src/config/env.js';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  ...(env.DIRECT_URL
    ? {
        datasource: {
          url: env.DIRECT_URL
        }
      }
    : {})
});
