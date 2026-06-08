import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { getEnv } from '../env.js';
import * as schema from './schema/index.js';
import { logger } from '../observability/logger.js';

const MIGRATIONS = [
    // Enable pgvector
    `CREATE EXTENSION IF NOT EXISTS vector`,

    // apps
    `CREATE TABLE IF NOT EXISTS apps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_key VARCHAR(128) NOT NULL UNIQUE,
    name VARCHAR(256) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

    // app_configs
    `CREATE TABLE IF NOT EXISTS app_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_key VARCHAR(128) NOT NULL UNIQUE REFERENCES apps(app_key),
    name VARCHAR(256) NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

    // runs
    `CREATE TABLE IF NOT EXISTS runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id VARCHAR(128) NOT NULL UNIQUE,
    thread_id VARCHAR(128) NOT NULL,
    app VARCHAR(128) NOT NULL,
    app_key VARCHAR(128),
    issue_text TEXT NOT NULL,
    mode VARCHAR(16) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'running',
    reported_by VARCHAR(256) NOT NULL,
    output JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
    `CREATE INDEX IF NOT EXISTS runs_app_idx ON runs(app)`,
    `CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status)`,

    // run_events (timeline, append-only)
    `CREATE TABLE IF NOT EXISTS run_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id VARCHAR(128) NOT NULL,
    seq INTEGER NOT NULL,
    node VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    summary TEXT,
    duration_ms INTEGER,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
    `CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id)`,

    // case_memories with pgvector embedding
    `CREATE TABLE IF NOT EXISTS case_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id VARCHAR(128) NOT NULL UNIQUE,
    app VARCHAR(128) NOT NULL,
    case_type VARCHAR(64) NOT NULL,
    title VARCHAR(512) NOT NULL,
    issue_summary TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    fix TEXT,
    signals JSONB NOT NULL DEFAULT '[]',
    reusable_insight TEXT NOT NULL,
    confidence VARCHAR(8) NOT NULL,
    source_run_id VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    embedding vector(2048)
  )`,
    `CREATE INDEX IF NOT EXISTS case_memories_app_idx ON case_memories(app)`,
    `CREATE INDEX IF NOT EXISTS case_memories_case_type_idx ON case_memories(case_type)`,

    // tools catalog
    `CREATE TABLE IF NOT EXISTS tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_id VARCHAR(128) NOT NULL UNIQUE,
    name VARCHAR(256) NOT NULL,
    description TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    surface VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

    // M1: store original request payload for deferred graph execution
    `ALTER TABLE runs ADD COLUMN IF NOT EXISTS request_payload JSONB`,

    // M2: app knowledge from web/docs (Phase C)
    `CREATE TABLE IF NOT EXISTS app_knowledge (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_key VARCHAR(128) NOT NULL,
    source VARCHAR(32) NOT NULL,
    url TEXT,
    title TEXT NOT NULL,
    chunk TEXT NOT NULL,
    embedding vector(2048),
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
    `CREATE INDEX IF NOT EXISTS app_knowledge_app_key_idx ON app_knowledge(app_key)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS app_knowledge_hash_idx ON app_knowledge(app_key, content_hash)`,
];

export async function runMigrations(): Promise<void> {
    const env = getEnv();
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
    try {
        logger.info('Running migrations...');
        for (const stmt of MIGRATIONS) {
            await pool.query(stmt);
        }
        logger.info('Migrations complete');
    } finally {
        await pool.end();
    }
}

// Script entry point
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
    runMigrations().catch((err) => {
        logger.error(err, 'Migration failed');
        process.exit(1);
    });
}
