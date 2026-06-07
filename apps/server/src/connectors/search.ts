/**
 * Tavily web search connector.
 * Returns null (skip) when TAVILY_API_KEY is not set — no silent fallback.
 */
import { getEnv } from '../env.js';
import { logger } from '../observability/logger.js';

export interface TavilyResult {
    url: string;
    title: string;
    content: string;
    score: number;
}

export async function tavilySearch(
    query: string,
    maxResults = 5,
): Promise<TavilyResult[] | null> {
    const { TAVILY_API_KEY } = getEnv();
    if (!TAVILY_API_KEY) {
        logger.warn({ query }, 'tavilySearch: TAVILY_API_KEY not set — skipping web search');
        return null;
    }

    try {
        const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: TAVILY_API_KEY,
                query,
                max_results: maxResults,
                search_depth: 'basic',
                include_raw_content: false,
            }),
        });

        if (!res.ok) {
            logger.warn({ status: res.status, query }, 'tavilySearch: non-200 response');
            return null;
        }

        const data = (await res.json()) as { results?: Array<{ url: string; title: string; content: string; score: number }> };
        return (data.results ?? []).map((r) => ({
            url: r.url,
            title: r.title,
            content: r.content,
            score: r.score,
        }));
    } catch (err) {
        logger.warn({ err, query }, 'tavilySearch: fetch failed');
        return null;
    }
}
