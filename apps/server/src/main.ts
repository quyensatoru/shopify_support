import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Load .env from workspace root (shopifysupport/.env), works regardless of cwd
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import { getEnv } from './env.js';
import { buildApp } from './http/app.js';
import { runMigrations } from './db/migrate.js';
import { logger } from './observability/logger.js';

async function main() {
    const env = getEnv();

    if (env.DATABASE_MIGRATE_ON_START) {
        await runMigrations();
    }

    const app = buildApp();

    const server = app.listen(env.PORT, () => {
        logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server started');
    });

    const shutdown = (signal: string) => {
        logger.info({ signal }, 'Shutting down server');

        server.close((err) => {
            if (err) {
                logger.error(err, 'Error while closing server');
                process.exit(1);
            }

            logger.info('Server closed');
            process.exit(0);
        });

        setTimeout(() => {
            logger.warn('Force exit after timeout');
            process.exit(1);
        }, 5000).unref();
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
    logger.error(err, 'Fatal startup error');
    process.exit(1);
});
