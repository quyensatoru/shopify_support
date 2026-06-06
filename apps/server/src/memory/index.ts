import type { CaseMemory } from '@shopify-support/shared';
import { insertMemory, similarMemories, updateMemoryEmbedding, listMemories } from '../db/repo/index.js';
import { getLlm } from '../llm/index.js';
import { logger } from '../observability/logger.js';

export async function writeMemory(memory: CaseMemory): Promise<void> {
  await insertMemory(memory);

  // Embed asynchronously so it doesn't block the graph
  embedAndSave(memory).catch((err) => {
    logger.warn({ err, memoryId: memory.id }, 'Failed to embed memory (non-fatal)');
  });
}

async function embedAndSave(memory: CaseMemory): Promise<void> {
  const text = `${memory.title}. ${memory.issueSummary}. ${memory.reusableInsight}`;
  const embedding = await getEmbedding(text);
  if (!embedding) return;
  await updateMemoryEmbedding(memory.id, JSON.stringify(embedding));
}

async function getEmbedding(text: string): Promise<number[] | null> {
  // Anthropic doesn't have an embedding API — use a simple text hash for now as placeholder.
  // In production: use OpenAI text-embedding-3-small or a self-hosted embedder.
  // The pgvector column is 1536-dim to match OpenAI ada-002 / 3-small.
  // For M0: return null (similarity search skipped until embedder is configured).
  const EMBEDDING_API_URL = process.env['EMBEDDING_API_URL'];
  if (!EMBEDDING_API_URL) return null;

  try {
    const res = await fetch(EMBEDDING_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { embedding?: number[] };
    return data.embedding ?? null;
  } catch {
    return null;
  }
}

export async function retrieveMemories(
  app: string,
  issueText: string,
  limit = 5,
): Promise<CaseMemory[]> {
  // Without embedding: fall back to keyword search in DB
  const rows = await listMemories({ app, q: issueText.slice(0, 50), limit });
  return rows.map((r) => ({
    id: r.memoryId,
    app: r.app,
    caseType: r.caseType as CaseMemory['caseType'],
    title: r.title,
    issueSummary: r.issueSummary,
    rootCause: r.rootCause,
    fix: r.fix ?? undefined,
    signals: (r.signals as string[]) ?? [],
    reusableInsight: r.reusableInsight,
    confidence: r.confidence as CaseMemory['confidence'],
    sourceRunId: r.sourceRunId,
    createdAt: r.createdAt.toISOString(),
  }));
}
