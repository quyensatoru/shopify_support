/**
 * App knowledge: learn from the web / docs and retrieve via pgvector.
 *
 * learnApp(appKey, config, onStep?):
 *   1. Tavily web search on app name
 *   2. Crawl docUrls via Firecrawl (multi-page, clean markdown) or Playwright fallback
 *   3. Crawl homepage / appStoreUrl (single page)
 *   4. Chunk each page → embed → store in app_knowledge (dedup by content_hash)
 *
 * Requires FIRECRAWL_API_KEY for multi-page doc crawling.
 * Falls back to single-page Playwright if key is absent.
 *
 * retrieveAppKnowledge(appKey, issueText, k):
 *   pgvector cosine similarity search, returns null if no embedding available.
 */

import { createHash } from 'node:crypto';
import Firecrawl from 'firecrawl';
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
import { getEnv } from '../env.js';

const CHUNK_SIZE = 800;
const MAX_CHUNKS_PER_SOURCE = 10;
// How many pages to crawl per docUrl when using Firecrawl (root + sub-pages)
const FIRECRAWL_PAGE_LIMIT = 50;

export type LearnStep =
    | { type: 'searching'; message: string }
    | { type: 'crawling'; url: string; message: string }
    | { type: 'stored'; url: string; chunks: number; message: string }
    | { type: 'skipped'; url: string; message: string }
    | { type: 'done'; total: number; message: string };

// ── Helpers ─────────────────────────────────────────────────────────────

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

// Strip scripts/styles then all tags, normalize whitespace — used as Playwright fallback.
function extractText(html: string, maxChars: number): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars);
}

async function storeChunks(
    appKey: string,
    source: string,
    url: string | undefined,
    title: string,
    body: string,
): Promise<number> {
    const chunks = chunkText(body.trim());
    let stored = 0;
    for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const hash = contentHash(`${appKey}:${source}:${chunk}`);
        try {
            await insertAppKnowledgeChunk({ appKey, source, url, title, chunk, contentHash: hash });
            const vec = await embed(chunk);
            if (vec) await updateAppKnowledgeEmbedding(hash, appKey, JSON.stringify(vec));
            stored++;
        } catch (err) {
            logger.warn({ err, appKey, source }, 'storeChunks: insert/embed failed (non-fatal)');
        }
    }
    return stored;
}

// ── Firecrawl client (lazy singleton) ────────────────────────────────────

let _fc: Firecrawl | undefined;
function getFirecrawl(): Firecrawl | undefined {
    const key = getEnv().FIRECRAWL_API_KEY;
    if (!key) return undefined;
    _fc ??= new Firecrawl({ apiKey: key });
    return _fc;
}

// ── learnApp ────────────────────────────────────────────────────────────

export async function learnApp(
    appKey: string,
    config: ResolvedAppConfig,
    onStep?: (step: LearnStep) => void,
): Promise<number> {
    const emit = (step: LearnStep) => onStep?.(step);
    const fc = getFirecrawl();
    let total = 0;

    // 1. Tavily web search
    emit({ type: 'searching', message: `Searching web: "${config.name} Shopify app documentation"` });
    try {
        const results = await tavilySearch(`${config.name} Shopify app documentation`, 5);
        if (results) {
            for (const r of results) {
                const n = await storeChunks(appKey, 'web_search', r.url, r.title, r.content);
                total += n;
                emit({ type: 'stored', url: r.url ?? '', chunks: n, message: `[search] ${r.title} — ${n} chunks` });
            }
        }
    } catch (err) {
        logger.warn({ err }, 'learnApp: tavilySearch failed (non-fatal)');
    }

    // 2. Crawl docUrls — multi-page via Firecrawl, or single-page via Playwright
    for (const url of config.docUrls ?? []) {
        total += fc
            ? await crawlWithFirecrawl(fc, url, appKey, 'doc_url', true, emit)
            : await crawlWithPlaywright(url, appKey, 'doc_url', 12_000, emit);
    }

    // 3. Homepage (single page — usually marketing, not docs)
    if (config.homepage) {
        total += fc
            ? await crawlWithFirecrawl(fc, config.homepage, appKey, 'doc_url', false, emit)
            : await crawlWithPlaywright(config.homepage, appKey, 'doc_url', 8_000, emit);
    }

    // 4. App store page (single page)
    if (config.appStoreUrl) {
        total += fc
            ? await crawlWithFirecrawl(fc, config.appStoreUrl, appKey, 'app_store', false, emit)
            : await crawlWithPlaywright(config.appStoreUrl, appKey, 'app_store', 8_000, emit);
    }

    emit({ type: 'done', total, message: `Done — ${total} chunks stored` });
    logger.info({ appKey, total }, 'learnApp: complete');
    return total;
}

// ── Firecrawl crawl ──────────────────────────────────────────────────────

async function crawlWithFirecrawl(
    fc: Firecrawl,
    url: string,
    appKey: string,
    source: 'doc_url' | 'app_store',
    multiPage: boolean,
    emit: (s: LearnStep) => void,
): Promise<number> {
    emit({ type: 'crawling', url, message: `[Firecrawl] Crawling ${url}${multiPage ? ` (up to ${FIRECRAWL_PAGE_LIMIT} pages)` : ''}` });
    let stored = 0;

    try {
        if (multiPage) {
            const job = await fc.crawl(url, {
                limit: FIRECRAWL_PAGE_LIMIT,
                scrapeOptions: { formats: ['markdown'] },
            });

            for (const doc of job.data) {
                const pageUrl = doc.metadata?.sourceURL ?? url;
                const title = doc.metadata?.title ?? doc.metadata?.ogTitle ?? pageUrl;
                const text = doc.markdown ?? '';
                if (!text.trim()) continue;

                emit({ type: 'crawling', url: pageUrl, message: `  → ${pageUrl}` });
                const n = await storeChunks(appKey, source, pageUrl, title, text);
                stored += n;
                emit({ type: 'stored', url: pageUrl, chunks: n, message: `  ✓ ${title} — ${n} chunks` });
            }

            if (job.data.length === 0) {
                emit({ type: 'skipped', url, message: `[Firecrawl] No pages returned for ${url}` });
            }
        } else {
            // Single page scrape
            const doc = await fc.scrape(url, { formats: ['markdown'] });
            const pageUrl = doc.metadata?.sourceURL ?? url;
            const title = doc.metadata?.title ?? doc.metadata?.ogTitle ?? pageUrl;
            const text = doc.markdown ?? '';
            if (text.trim()) {
                const n = await storeChunks(appKey, source, pageUrl, title, text);
                stored += n;
                emit({ type: 'stored', url: pageUrl, chunks: n, message: `[Firecrawl] ${title} — ${n} chunks` });
            } else {
                emit({ type: 'skipped', url, message: `[Firecrawl] Empty content for ${url}` });
            }
        }
    } catch (err) {
        emit({ type: 'skipped', url, message: `[Firecrawl] Failed ${url}: ${String(err).slice(0, 80)}` });
        logger.warn({ err, url }, 'learnApp: firecrawl failed (non-fatal)');
    }

    return stored;
}

// ── Playwright fallback ──────────────────────────────────────────────────

async function crawlWithPlaywright(
    url: string,
    appKey: string,
    source: 'doc_url' | 'app_store',
    maxText: number,
    emit: (s: LearnStep) => void,
): Promise<number> {
    emit({ type: 'crawling', url, message: `[Playwright] Crawling ${url}` });
    let stored = 0;
    try {
        const page = await renderPage(url);
        const body = extractText(page.html, maxText);
        const n = await storeChunks(appKey, source, url, page.title || url, body);
        stored += n;
        emit({ type: 'stored', url, chunks: n, message: `[Playwright] ${page.title || url} — ${n} chunks` });
    } catch (err) {
        emit({ type: 'skipped', url, message: `[Playwright] Failed ${url}: ${String(err).slice(0, 80)}` });
        logger.warn({ err, url }, 'learnApp: playwright crawl failed (non-fatal)');
    }
    return stored;
}

// ── Retrieve ─────────────────────────────────────────────────────────────

export async function retrieveAppKnowledge(
    appKey: string,
    issueText: string,
    k = 5,
): Promise<AppKnowledgeChunk[] | null> {
    const vec = await embed(issueText);
    if (!vec) {
        logger.warn({ appKey }, 'retrieveAppKnowledge: embed returned null — skipping');
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
