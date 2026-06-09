import type { CaseMemory } from '@shopify-support/shared';
import { insertMemory, similarMemories, updateMemoryEmbedding } from '../db/repo/index.js';
import { embed } from '../llm/embeddings.js';
import { logger } from '../observability/logger.js';

export async function writeMemory(memory: CaseMemory): Promise<void> {
    await insertMemory(memory);
    // Embed asynchronously — non-blocking, non-fatal
    embedAndSave(memory).catch((err) => {
        logger.warn({ err, memoryId: memory.id }, 'Failed to embed memory (non-fatal)');
    });
}

async function embedAndSave(memory: CaseMemory): Promise<void> {
    const text = `${memory.title}. ${memory.issueSummary}. ${memory.reusableInsight}`;
    const embedding = await embed(text);
    if (!embedding) return;
    await updateMemoryEmbedding(memory.id, JSON.stringify(embedding));
}

/**
 * Retrieve similar memories via pgvector cosine similarity.
 * Returns empty array (not an error) when embedding is unavailable — callers log the gap.
 */
export async function retrieveMemories(
    app: string,
    issueText: string,
    limit = 5,
): Promise<CaseMemory[]> {
    const embedding = await embed(issueText);
    if (!embedding) {
        logger.warn({ app }, 'Embedding unavailable — memory retrieve skipped (no OPENAI_API_KEY)');
        return [];
    }

    const rows = await similarMemories(app, JSON.stringify(embedding), limit);
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
        createdAt: new Date(r.createdAt).toISOString(),
    }));
}
