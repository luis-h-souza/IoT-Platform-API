import 'dotenv/config';
import { z } from 'zod';

const portSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') {
      return value;
    }

    const normalizedValue = value.trim();

    if (normalizedValue === '') {
      return value;
    }

    if (!/^\d+$/.test(normalizedValue)) {
      return Number.NaN;
    }

    return Number(normalizedValue);
  },
  z.number().int().min(1).max(65535).default(3000)
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: portSchema,
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info')
});

const fieldProblems = {
  NODE_ENV: 'deve ser development, test ou production.',
  PORT: 'deve ser um inteiro entre 1 e 65535 e não pode estar vazio.',
  LOG_LEVEL: 'deve ser error, warn, info ou debug.'
};

export function parseEnv(source = process.env) {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const invalidFields = [
      ...new Set(
        result.error.issues.map((issue) => {
          const field = String(issue.path[0] ?? 'environment');
          const problem = fieldProblems[field] ?? 'contém uma configuração inválida.';

          return `- ${field}: ${problem}`;
        })
      )
    ];

    throw new Error(`Configuração de ambiente inválida:\n${invalidFields.join('\n')}`);
  }

  return result.data;
}

export const env = parseEnv();
