import express from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health.js';
import { runsRouter } from './routes/runs.js';
import { appsRouter } from './routes/apps.js';
import { memoryRouter } from './routes/memory.js';
import { toolsRouter } from './routes/tools.js';
import { logger } from '../observability/logger.js';

export function buildApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Request logger
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'request');
    next();
  });

  app.use('/api', healthRouter);
  app.use('/api', runsRouter);
  app.use('/api', appsRouter);
  app.use('/api', memoryRouter);
  app.use('/api', toolsRouter);

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(err, 'unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
