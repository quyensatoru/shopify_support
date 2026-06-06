import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, desc, and, like, sql } from 'drizzle-orm';
import pg from 'pg';
import { getEnv } from '../../env.js';
import { apps, appConfigs, runs, runEvents, caseMemories, tools } from '../schema/index.js';
import type { StepLog, CaseMemory } from '@shopify-support/shared';

let _pool: pg.Pool | undefined;
let _db: ReturnType<typeof drizzle> | undefined;

function getDb() {
  if (_db) return _db;
  _pool = new pg.Pool({ connectionString: getEnv().DATABASE_URL });
  _db = drizzle(_pool);
  return _db;
}

export type AppConfigRow = {
  appKey: string;
  name: string;
  config: unknown;
};

// ── Apps ─────────────────────────────────────────────────────────────
export async function upsertApp(appKey: string, name: string) {
  const db = getDb();
  await db
    .insert(apps)
    .values({ appKey, name })
    .onConflictDoUpdate({ target: apps.appKey, set: { name, updatedAt: new Date() } });
}

export async function listApps() {
  return getDb().select().from(apps).orderBy(desc(apps.createdAt));
}

export async function getApp(appKey: string) {
  const rows = await getDb().select().from(apps).where(eq(apps.appKey, appKey)).limit(1);
  return rows[0] ?? null;
}

// ── App Configs ───────────────────────────────────────────────────────
export async function upsertAppConfig(
  appKey: string,
  name: string,
  config: Record<string, unknown>,
) {
  const db = getDb();
  await upsertApp(appKey, name);
  await db
    .insert(appConfigs)
    .values({ appKey, name, config })
    .onConflictDoUpdate({
      target: appConfigs.appKey,
      set: { name, config, updatedAt: new Date() },
    });
}

export async function getAppConfig(appKey: string): Promise<AppConfigRow | null> {
  const rows = await getDb()
    .select()
    .from(appConfigs)
    .where(eq(appConfigs.appKey, appKey))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { appKey: row.appKey, name: row.name, config: row.config };
}

// ── Runs ──────────────────────────────────────────────────────────────
export async function createRun(params: {
  runId: string;
  threadId: string;
  app: string;
  appKey?: string;
  issueText: string;
  mode: string;
  reportedBy: string;
}) {
  await getDb().insert(runs).values(params);
}

export async function updateRunStatus(
  runId: string,
  status: string,
  output?: unknown,
) {
  await getDb()
    .update(runs)
    .set({ status, ...(output !== undefined ? { output } : {}), updatedAt: new Date() })
    .where(eq(runs.runId, runId));
}

export async function getRun(runId: string) {
  const rows = await getDb().select().from(runs).where(eq(runs.runId, runId)).limit(1);
  return rows[0] ?? null;
}

export async function listRuns(params: {
  app?: string;
  status?: string;
  reportedBy?: string;
  limit: number;
  offset: number;
}) {
  const db = getDb();
  const conditions = [];
  if (params.app) conditions.push(eq(runs.app, params.app));
  if (params.status) conditions.push(eq(runs.status, params.status));
  if (params.reportedBy) conditions.push(eq(runs.reportedBy, params.reportedBy));

  return db
    .select()
    .from(runs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(params.limit)
    .offset(params.offset);
}

// ── Run Events ────────────────────────────────────────────────────────
export async function appendRunEvents(runId: string, steps: StepLog[]) {
  if (!steps.length) return;
  const db = getDb();
  await db.insert(runEvents).values(
    steps.map((s) => ({
      runId,
      seq: s.seq,
      node: s.node,
      status: s.status,
      summary: s.summary,
      durationMs: s.durationMs,
      ts: new Date(s.ts),
    })),
  );
}

export async function getRunEvents(runId: string) {
  return getDb()
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(runEvents.seq);
}

// ── Case Memories ─────────────────────────────────────────────────────
export async function insertMemory(memory: CaseMemory) {
  await getDb().insert(caseMemories).values({
    memoryId: memory.id,
    app: memory.app,
    caseType: memory.caseType,
    title: memory.title,
    issueSummary: memory.issueSummary,
    rootCause: memory.rootCause,
    fix: memory.fix,
    signals: memory.signals,
    reusableInsight: memory.reusableInsight,
    confidence: memory.confidence,
    sourceRunId: memory.sourceRunId,
    createdAt: new Date(memory.createdAt),
  });
}

export async function listMemories(params: {
  app?: string;
  caseType?: string;
  q?: string;
  limit: number;
}) {
  const db = getDb();
  const conditions = [];
  if (params.app) conditions.push(eq(caseMemories.app, params.app));
  if (params.caseType) conditions.push(eq(caseMemories.caseType, params.caseType));
  if (params.q) conditions.push(like(caseMemories.issueSummary, `%${params.q}%`));

  return db
    .select()
    .from(caseMemories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(caseMemories.createdAt))
    .limit(params.limit);
}

export async function deleteMemory(memoryId: string) {
  await getDb().delete(caseMemories).where(eq(caseMemories.memoryId, memoryId));
}

// Similarity search via pgvector (returns top-k similar memories)
export async function similarMemories(
  app: string,
  embeddingJson: string,
  limit = 5,
): Promise<Array<{ memoryId: string; issueSummary: string; rootCause: string; distance: number }>> {
  const db = getDb();
  // Use raw SQL for vector cosine similarity
  const result = await db.execute(sql`
    SELECT memory_id, issue_summary, root_cause,
           embedding <=> ${embeddingJson}::vector AS distance
    FROM case_memories
    WHERE app = ${app} AND embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ${limit}
  `);
  return (result.rows as Array<{ memory_id: string; issue_summary: string; root_cause: string; distance: number }>).map((r) => ({
    memoryId: r.memory_id,
    issueSummary: r.issue_summary,
    rootCause: r.root_cause,
    distance: r.distance,
  }));
}

export async function updateMemoryEmbedding(memoryId: string, embeddingJson: string) {
  const db = getDb();
  await db.execute(sql`
    UPDATE case_memories
    SET embedding = ${embeddingJson}::vector
    WHERE memory_id = ${memoryId}
  `);
}

// ── Tools ─────────────────────────────────────────────────────────────
export async function listToolsFromDb() {
  return getDb().select().from(tools);
}

export async function setToolEnabled(toolId: string, enabled: boolean) {
  await getDb().update(tools).set({ enabled }).where(eq(tools.toolId, toolId));
}
