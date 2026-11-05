import express from 'express';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';

const app = express();

// Middlewares globais
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'iot-platform-api',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Fallback 404 após as rotas e tratamento de erros por último.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
