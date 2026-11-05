import 'dotenv/config';
import { performance } from 'node:perf_hooks';

if (!process.env.DATABASE_URL) {
  console.log('Teste de conectividade ignorado: DATABASE_URL não configurada.');
  process.exit(0);
}

function sanitizeErrorText(value) {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi, '[URL PostgreSQL removida]')
    .replace(/(password|passwd|pwd|username|user)\s*[=:]\s*[^,\s;]+/gi, '$1=[removido]');
}

function describeError(error, depth = 0) {
  if (depth > 2) {
    return '';
  }

  if (!error || typeof error !== 'object') {
    return sanitizeErrorText(String(error));
  }

  const fields = ['name', 'type', 'message', 'code'];
  const details = fields
    .filter((field) => typeof error[field] === 'string' && error[field] !== '')
    .map((field) => sanitizeErrorText(error[field]));

  for (const nestedError of [error.error, error.cause]) {
    if (nestedError && nestedError !== error) {
      const nestedDetails = describeError(nestedError, depth + 1);
      if (nestedDetails) {
        details.push(nestedDetails);
      }
    }
  }

  return details.join(': ') || error.constructor?.name || 'Unknown error';
}

function getSafeErrorDetails(error) {
  return describeError(error);
}

let prisma;
let startedAt;

try {
  ({ prisma } = await import('../src/db/prisma.js'));
  startedAt = performance.now();

  await prisma.$connect();
  const result = await prisma.$queryRaw`SELECT 1 AS result`;
  const elapsedMs = (performance.now() - startedAt).toFixed(2);

  console.log('Conexão com Neon estabelecida usando DATABASE_URL.');
  console.log(`Resultado de SELECT 1: ${JSON.stringify(result)}`);
  console.log(`Tempo de execução: ${elapsedMs} ms.`);
} catch (error) {
  console.error(`Falha no teste de conectividade com Neon: ${getSafeErrorDetails(error)}`);
  process.exitCode = 1;
} finally {
  if (prisma) {
    try {
      await prisma.$disconnect();
      console.log('Conexão encerrada corretamente.');
    } catch (error) {
      console.error(`Falha ao encerrar a conexão: ${getSafeErrorDetails(error)}`);
      process.exitCode = 1;
    }
  } else {
    console.log('Prisma Client não inicializado; encerramento não aplicável.');
  }
}
