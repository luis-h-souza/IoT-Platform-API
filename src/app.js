import express from 'express';

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

export default app;