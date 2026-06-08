/**
 * App knowledge: learn from the web / docs and retrieve via pgvector.
 *
 * learnApp(appKey, config, onStep?):
 *   1. Tavily web search on app name
 *   2. Crawl docUrls via playwright, following same-domain links up to MAX_SUBPAGES deep
 *   3. Crawl homepage / appStoreUrl
 *   4. Chunk each page → embed → store in app_knowledge (dedup by content_hash)
 *
 * retrieveAppKnowledge(appKey, issueText, k):
 *   pgvector cosine similarity search, returns null if no embedding available.
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

const CHUNK_SIZE = 800;
const MAX_CHUNKS_PER_SOURCE = 10;
const MAX_SUBPAGES = 4; // sub-links to follow per docUrl

export type LearnStep =
    | { type: 'searching'; message: string }
    | { type: 'crawling'; url: string; message: string }
    | { type: 'stored'; url: string; chunks: number; message: string }
    | { type: 'skipped'; url: string; message: string }
    | { type: 'done'; total: number; message: string };

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

// Strip scripts/styles then tags, normalize whitespace.
function extractText(html: string, maxChars: number): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars);
}

// Extract same-origin links from HTML, limited to MAX_SUBPAGES unique paths.
function extractDocLinks(html: string, baseUrl: string): string[] {
    let base: URL;
    try {
        base = new URL(baseUrl);
    } catch {
        return [];
    }
    const seen = new Set<string>();
    const results: string[] = [];
    const re = /href=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        try {
            const abs = new URL(m[1]!, baseUrl);
            // Same origin, different path, no fragments, no query-only diffs
            if (
                abs.origin === base.origin &&
                abs.pathname !== base.pathname &&
                abs.pathname !== '/' &&
                !abs.pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|css|js)$/i) &&
                !seen.has(abs.pathname)
            ) {
                seen.add(abs.pathname);
                results.push(abs.href.split('#')[0]!);
                if (results.length >= MAX_SUBPAGES) break;
            }
        } catch {}
    }
    return results;
}

async function storeChunks(
    appKey: string,
    source: string,
    url: string | undefined,
    title: string,
    body: string,
): Promise<number> {
    const chunks = chunkText(body);
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

export async function learnApp(
    appKey: string,
    config: ResolvedAppConfig,
    onStep?: (step: LearnStep) => void,
): Promise<number> {
    const emit = (step: LearnStep) => onStep?.(step);
    let total = 0;

    // 1. Tavily web search
    emit({ type: 'searching', message: `Searching web: "${config.name} Shopify app documentation"` });
    try {
        const searchResults = await tavilySearch(`${config.name} Shopify app documentation`, 5);
        if (searchResults) {
            for (const r of searchResults) {
                const n = await storeChunks(appKey, 'web_search', r.url, r.title, r.content);
                total += n;
                emit({ type: 'stored', url: r.url ?? '', chunks: n, message: `[search] ${r.title} — ${n} chunks` });
            }
        }
    } catch (err) {
        logger.warn({ err }, 'learnApp: tavilySearch failed (non-fatal)');
    }

    // Shared crawl helper: renders a page, stores chunks, optionally follows sub-links.
    const crawlPage = async (
        url: string,
        source: 'doc_url' | 'app_store',
        maxText: number,
        followLinks: boolean,
    ) => {
        emit({ type: 'crawling', url, message: `Crawling ${url}` });
        let page;
        try {
            page = await renderPage(url);
        } catch (err) {
            emit({ type: 'skipped', url, message: `Skipped ${url}: ${String(err).slice(0, 80)}` });
            logger.warn({ err, url }, 'learnApp: renderPage failed (non-fatal)');
            return;
        }

        const body = extractText(page.html, maxText);
        const n = await storeChunks(appKey, source, url, page.title || url, body);
        total += n;
        emit({ type: 'stored', url, chunks: n, message: `[${source}] ${page.title || url} — ${n} chunks` });

        if (!followLinks) return;

        // Follow same-domain links
        const subLinks = extractDocLinks(page.html, url);
        for (const link of subLinks) {
            emit({ type: 'crawling', url: link, message: `  → ${link}` });
            try {
                const sub = await renderPage(link);
                const subBody = extractText(sub.html, maxText);
                const sn = await storeChunks(appKey, source, link, sub.title || link, subBody);
                total += sn;
                emit({ type: 'stored', url: link, chunks: sn, message: `  → [${source}] ${sub.title || link} — ${sn} chunks` });
            } catch (err) {
                emit({ type: 'skipped', url: link, message: `  → Skipped ${link}: ${String(err).slice(0, 60)}` });
                logger.warn({ err, link }, 'learnApp: sub-page crawl failed (non-fatal)');
            }
        }
    };

    // 2. Crawl docUrls (with sub-link following)
    for (const url of config.docUrls ?? []) {
        await crawlPage(url, 'doc_url', 12_000, true);
    }

    // 3. Homepage (no sub-links — usually marketing, not docs)
    if (config.homepage) {
        await crawlPage(config.homepage, 'doc_url', 8_000, false);
    }

    // 4. App store page
    if (config.appStoreUrl) {
        await crawlPage(config.appStoreUrl, 'app_store', 8_000, false);
    }

    emit({ type: 'done', total, message: `Done — ${total} chunks stored` });
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
