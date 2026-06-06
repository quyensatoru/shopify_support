import {
    boolean,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uuid,
    varchar,
    integer,
} from 'drizzle-orm/pg-core';

export const apps = pgTable('apps', {
    id: uuid('id').primaryKey().defaultRandom(),
    appKey: varchar('app_key', { length: 128 }).notNull().unique(),
    name: varchar('name', { length: 256 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Secrets stored as encrypted strings inside config jsonb
export const appConfigs = pgTable('app_configs', {
    id: uuid('id').primaryKey().defaultRandom(),
    appKey: varchar('app_key', { length: 128 })
        .notNull()
        .unique()
        .references(() => apps.appKey),
    name: varchar('name', { length: 256 }).notNull(),
    config: jsonb('config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable(
    'runs',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        runId: varchar('run_id', { length: 128 }).notNull().unique(),
        threadId: varchar('thread_id', { length: 128 }).notNull(),
        app: varchar('app', { length: 128 }).notNull(),
        appKey: varchar('app_key', { length: 128 }),
        issueText: text('issue_text').notNull(),
        mode: varchar('mode', { length: 16 }).notNull(),
        status: varchar('status', { length: 32 }).notNull().default('running'),
        reportedBy: varchar('reported_by', { length: 256 }).notNull(),
        output: jsonb('output'),
        requestPayload: jsonb('request_payload'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index('runs_app_idx').on(t.app), index('runs_status_idx').on(t.status)],
);

export const runEvents = pgTable(
    'run_events',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        runId: varchar('run_id', { length: 128 }).notNull(),
        seq: integer('seq').notNull(),
        node: varchar('node', { length: 64 }).notNull(),
        status: varchar('status', { length: 32 }).notNull(),
        summary: text('summary'),
        durationMs: integer('duration_ms'),
        ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index('run_events_run_idx').on(t.runId)],
);

export const caseMemories = pgTable(
    'case_memories',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        memoryId: varchar('memory_id', { length: 128 }).notNull().unique(),
        app: varchar('app', { length: 128 }).notNull(),
        caseType: varchar('case_type', { length: 64 }).notNull(),
        title: varchar('title', { length: 512 }).notNull(),
        issueSummary: text('issue_summary').notNull(),
        rootCause: text('root_cause').notNull(),
        fix: text('fix'),
        signals: jsonb('signals').notNull().default([]),
        reusableInsight: text('reusable_insight').notNull(),
        confidence: varchar('confidence', { length: 8 }).notNull(),
        sourceRunId: varchar('source_run_id', { length: 128 }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        // pgvector embedding column added via raw migration
    },
    (t) => [
        index('case_memories_app_idx').on(t.app),
        index('case_memories_case_type_idx').on(t.caseType),
    ],
);

export const tools = pgTable('tools', {
    id: uuid('id').primaryKey().defaultRandom(),
    toolId: varchar('tool_id', { length: 128 }).notNull().unique(),
    name: varchar('name', { length: 256 }).notNull(),
    description: text('description').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    surface: varchar('surface', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
