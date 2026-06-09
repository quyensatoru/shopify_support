import { z } from 'zod';
import { getStructuredLlmFast } from '../llm/index.js';
import { logger } from '../observability/logger.js';

/**
 * Code-search keys must be ENGLISH technical terms — the codebase symbols are in
 * English while the issue is often in Vietnamese. Feeding the raw issue text to
 * codegraph matches "common words" and returns boilerplate. This step extracts a
 * concise English search query + keyword list to ground retrieval.
 */
const KeywordOutputSchema = z.object({
    searchQuery: z
        .string()
        .describe('A concise ENGLISH technical search phrase (3-8 words) for code search'),
    keywords: z
        .array(z.string())
        .describe('English technical terms likely to appear as code identifiers/symbols/filenames'),
});

export type ExtractedKeywords = z.infer<typeof KeywordOutputSchema>;

export async function runKeywordExtraction(input: {
    issueText: string;
    appName: string;
    repos?: string[];
    dbTypes?: string[];
}): Promise<ExtractedKeywords> {
    const fallback = (): ExtractedKeywords => {
        // Deterministic fallback: keep ascii word-ish tokens from the issue.
        const tokens = input.issueText
            .split(/[^A-Za-z0-9_]+/)
            .filter((t) => t.length >= 3 && /[A-Za-z]/.test(t))
            .slice(0, 8);
        return { searchQuery: tokens.join(' ') || input.appName, keywords: tokens };
    };

    try {
        const structured = getStructuredLlmFast(KeywordOutputSchema, 'keyword_extraction');
        const prompt = `You map a support issue (any language) to ENGLISH technical search terms for searching a codebase.

App: ${input.appName}
${input.repos?.length ? `Repos: ${input.repos.join(', ')}` : ''}
${input.dbTypes?.length ? `Data stores: ${input.dbTypes.join(', ')}` : ''}
Issue: ${input.issueText}

Output English technical terms that are likely to appear as identifiers, function/class names, file names, or constants in the source code for this issue. Think about the feature domain and failure mode.
Examples: a "heatmap shows blank" issue → ["heatmap","render","canvas","snapshot","rrweb","replay","decompress","blank"]; an "install fails" issue → ["oauth","install","callback","accessToken","scope","redirect"].
Do NOT output the original-language words. Do NOT output generic words like "customer","screen","error". Keep keywords lowercase technical terms.`;
        const result = await structured.invoke(prompt);
        if (!result?.searchQuery) return fallback();
        return result;
    } catch (err) {
        logger.warn({ err }, 'keyword extraction failed — using deterministic fallback');
        return fallback();
    }
}
