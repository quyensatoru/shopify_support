import OpenAI from 'openai';
import { getEnv } from '../env.js';
import { logger } from '../observability/logger.js';

let _client: OpenAI | undefined;

function getClient(): OpenAI | null {
    const env = getEnv();
    if (!env.OPENAI_API_KEY) return null;
    if (!_client) _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    return _client;
}

/**
 * Embed a single text string.
 * Returns null if OPENAI_API_KEY is not set — callers must handle the null case
 * (no keyword fallback; skip with reason per project policy).
 */
export async function embed(text: string): Promise<number[] | null> {
    const client = getClient();
    if (!client) {
        logger.warn('OPENAI_API_KEY not set — embedding unavailable');
        return null;
    }
    try {
        const res = await client.embeddings.create({
            model: getEnv().EMBEDDING_MODEL,
            input: text,
        });
        return res.data[0]?.embedding ?? null;
    } catch (err) {
        logger.error({ err }, 'Embedding API call failed');
        return null;
    }
}

/**
 * Embed multiple texts in one API call (cheaper per-token than individual calls).
 */
export async function embedBatch(texts: string[]): Promise<number[][] | null> {
    if (!texts.length) return [];
    const client = getClient();
    if (!client) {
        logger.warn('OPENAI_API_KEY not set — batch embedding unavailable');
        return null;
    }
    try {
        const res = await client.embeddings.create({
            model: getEnv().EMBEDDING_MODEL,
            input: texts,
        });
        return res.data.map((d) => d.embedding);
    } catch (err) {
        logger.error({ err }, 'Batch embedding API call failed');
        return null;
    }
}
