import pino from 'pino';

export const logger = pino({
  level: process.env['NODE_ENV'] === 'production' ? 'info' : 'debug',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
      : undefined,
});

export function runLogger(runId: string, threadId: string) {
  return logger.child({ runId, threadId });
}
