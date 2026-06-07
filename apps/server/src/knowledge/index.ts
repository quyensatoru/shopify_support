/**
 * App knowledge: learn from the web / docs and retrieve via pgvector.
 *
 * learnApp(appKey, config):
 *   1. Tavily web search on app name
 *   2. Crawl docUrls / homepage / appStoreUrl via playwright
 *   3. Chunk each page → embed → store in app_knowledge (dedup by content_hash)
 *
 * retrieveAppKnowledge(appKey, issueText, k):
 *   pgvector cosine similarity search, returns null if no embedding available.
 *
 * No fallback — if embedding is unavailable, return skip with reason.
 */

import { createHash } from 'node:crypto';
import { embed } from '../llm/embeddings.js';
import { tavilySearch } from '../connectors/search.js';
import { renderPage } from '../connectors/playwright.js';
import {
    insertAppKnowledgeChunk,
    updateAppKnowledgeEmbedding,
    similarAppKnowledge,
    countAppKnowledge,
} from '../db/repo/index.js';
import type { ResolvedAppConfig } from '@shopify-support/shared';
import type { AppKnowledgeChunk } from '@shopify-support/shared';
import { logger } from '../observability/logger.js';

const CHUNK_SIZE = 800; // chars per chunk
const MAX_CHUNKS_PER_SOURCE = 6;

function chunkText(text: string): string[] {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < text.length) {
        chunks.push(text.slice(offset, offset + CHUNK_SIZE));
        offset += CHUNK_SIZE;
        if (chunks.length >= MAX_CHUNKS_PER_SOURCE) break;
    }
    return chunks;
}

function contentHash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 64);
}

async function storeChunks(
    appKey: string,
    source: string,
    url: string | undefined,
    title: string,
    body: string,
): Promise<number> {
    const chunks = chunkText(body.replace(/\s+/g, ' ').trim());
    let stored = 0;
    for (const chunk of chunks) {
        const hash = contentHash(`${appKey}:${source}:${chunk}`);
        try {
            await insertAppKnowledgeChunk({ appKey, source, url, title, chunk, contentHash: hash });
            const vec = await embed(chunk);
            if (vec) {
                await updateAppKnowledgeEmbedding(hash, appKey, JSON.stringify(vec));
            }
            stored++;
        } catch (err) {
            logger.warn({ err, appKey, source }, 'storeChunks: insert/embed failed (non-fatal)');
        }
    }
    return stored;
}

export async function learnApp(appKey: string, config: ResolvedAppConfig): Promise<number> {
    let total = 0;

    // 1. Tavily web search
    const searchResults = await tavilySearch(`${config.name} Shopify app documentation`, 5);
    if (searchResults) {
        for (const r of searchResults) {
            total += await storeChunks(appKey, 'web_search', r.url, r.title, r.content);
        }
    }

    // 2. Crawl docUrls
    for (const url of config.docUrls ?? []) {
        try {
            const page = await renderPage(url);
            const body = page.html.replace(/<[^>]+>/g, ' ').slice(0, 12_000);
            total += await storeChunks(appKey, 'doc_url', url, page.title || url, body);
        } catch (err) {
            logger.warn({ err, url }, 'learnApp: renderPage failed for docUrl (non-fatal)');
        }
    }

    // 3. Crawl homepage
    if (config.homepage) {
        try {
            const page = await renderPage(config.homepage);
            const body = page.html.replace(/<[^>]+>/g, ' ').slice(0, 8_000);
            total += await storeChunks(
                appKey,
                'doc_url',
                config.homepage,
                page.title || config.homepage,
                body,
            );
        } catch (err) {
            logger.warn(
                { err, url: config.homepage },
                'learnApp: renderPage failed for homepage (non-fatal)',
            );
        }
    }

    // 4. Crawl app store URL
    if (config.appStoreUrl) {
        try {
            const page = await renderPage(config.appStoreUrl);
            const body = page.html.replace(/<[^>]+>/g, ' ').slice(0, 8_000);
            total += await storeChunks(
                appKey,
                'app_store',
                config.appStoreUrl,
                page.title || 'App Store',
                body,
            );
        } catch (err) {
            logger.warn(
                { err, url: config.appStoreUrl },
                'learnApp: renderPage failed for appStoreUrl (non-fatal)',
            );
        }
    }

    logger.info({ appKey, total }, 'learnApp: complete');
    return total;
}

export async function retrieveAppKnowledge(
    appKey: string,
    issueText: string,
    k = 5,
): Promise<AppKnowledgeChunk[] | null> {
    const vec = await embed(issueText);
    if (!vec) {
        logger.warn(
            { appKey },
            'retrieveAppKnowledge: embed returned null — skipping (no OPENAI_API_KEY)',
        );
        return null;
    }

    try {
        const rows = await similarAppKnowledge(appKey, JSON.stringify(vec), k);
        return rows.map((r) => ({
            chunkId: r.chunkId,
            source: r.source as 'web_search' | 'doc_url' | 'app_store',
            url: r.url ?? undefined,
            title: r.title,
            chunk: r.chunk,
        }));
    } catch (err) {
        logger.warn({ err, appKey }, 'retrieveAppKnowledge: pgvector query failed (non-fatal)');
        return null;
    }
}

export async function hasAppKnowledge(appKey: string): Promise<boolean> {
    try {
        return (await countAppKnowledge(appKey)) > 0;
    } catch {
        return false;
    }
}
