
import 'dotenv/config';
import { z } from 'zod';

const portSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;

    const normalizedValue = value.trim();

    if (normalizedValue === '') return value;
    if (!/^\d+$/.test(normalizedValue)) return Number.NaN;

    return Number(normalizedValue);
  },
  z.number().int().min(1).max(65535).default(3000)
);

function isNeonPostgresUrl(value) {
  try {
    const url = new URL(value);

    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.hostname.endsWith('.neon.tech')
    );
  } catch {
    return false;
  }
}

function hasPoolerHostname(value, expectedPooled) {
  try {
    const endpointName = new URL(value).hostname.split('.')[0];
    return endpointName.endsWith('-pooler') === expectedPooled;
  } catch {
    return false;
  }
}

function optionalNeonUrl(expectedPooled) {
  return z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string()
      .url()
      .refine(isNeonPostgresUrl)
      .refine((value) => hasPoolerHostname(value, expectedPooled))
      .optional()
  );
}

function isLocalTestDatabaseUrl(value) {
  try {
    const url = new URL(value);

    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.port === '54329' &&
      url.pathname === '/iot_platform_test' &&
      decodeURIComponent(url.username) === 'iot_test' &&
      url.searchParams.get('schema') === 'public'
    );
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: portSchema,
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  DATABASE_URL: optionalNeonUrl(true),
  DIRECT_URL: optionalNeonUrl(false),

  TEST_DATABASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string()
      .url()
      .refine(
        isLocalTestDatabaseUrl,
        'deve apontar exclusivamente para o PostgreSQL local de testes.'
      )
      .optional()
  )
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === 'test' && !data.TEST_DATABASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['TEST_DATABASE_URL'],
      message: 'é obrigatória em ambiente de testes.'
    });
  }
});

const fieldProblems = {
  NODE_ENV: 'deve ser development, test ou production.',
  PORT: 'deve ser um inteiro entre 1 e 65535 e não pode estar vazio.',
  LOG_LEVEL: 'deve ser error, warn, info ou debug.',
  DATABASE_URL: 'deve ser uma URL PostgreSQL da Neon com hostname pooled (-pooler).',
  DIRECT_URL: 'deve ser uma URL PostgreSQL da Neon sem o sufixo -pooler.',
  TEST_DATABASE_URL: 'deve apontar para o PostgreSQL local autorizado e só pode ser usada em test.'
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

    throw new Error(
      `Configuração de ambiente inválida:\n${invalidFields.join('\n')}`
    );
  }

  return result.data;
}

export const env = parseEnv();
