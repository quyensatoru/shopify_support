import type { SupportStateType } from '../state.js';
import { getAppConfig } from '../../db/repo/index.js';
import { resolveAppConfig } from '../../config/index.js';
import { retrieveMemories } from '../../memory/index.js';
import { runKeywordExtraction } from '../../reasoning/keywords.js';
import { stepLog } from '../utils.js';
import type { Identifier } from '@shopify-support/shared';

/** Merge explicit identifiers with ones derivable from storeDomain/URL + providedContext. */
function normalizeIdentifiers(request: SupportStateType['request']): Identifier[] {
    const out: Identifier[] = [...(request.identifiers ?? [])];
    const add = (kind: Identifier['kind'], value?: string) => {
        const v = (value ?? '').trim();
        if (!v) return;
        if (out.some((i) => i.kind === kind && i.value === v)) return;
        out.push({ kind, value: v });
    };

    add('store_domain', request.storeDomain);
    if (request.storeUrl) add('store_url', request.storeUrl);
    // A CSE may have supplied shop_id / domain via an earlier ask_context interrupt.
    const provided = (request.metadata?.['providedContext'] ?? {}) as Record<string, unknown>;
    add('shop_id', typeof provided['shop_id'] === 'string' ? (provided['shop_id'] as string) : undefined);
    add(
        'store_domain',
        typeof provided['store_domain'] === 'string' ? (provided['store_domain'] as string) : undefined,
    );
    return out;
}

export async function intakeNode(state: SupportStateType) {
    const t0 = Date.now();
    const { request } = state;

    // 1. Resolve app config
    const configRow = await getAppConfig(request.appKey ?? request.app).catch(() => null);
    const appConfig = configRow ? resolveAppConfig(configRow) : undefined;

    // 2. Retrieve relevant memories (RAG) + extract English code-search keywords (parallel)
    const [retrievedMemories, keywords] = await Promise.all([
        retrieveMemories(request.app, request.issueText, 5),
        runKeywordExtraction({
            issueText: request.issueText,
            appName: appConfig?.name ?? request.app,
            repos: appConfig?.repos?.map((r) => r.name),
            dbTypes: appConfig?.dbSources?.map((d) => d.type),
        }),
    ]);

    const identifiers = normalizeIdentifiers(request);

    return {
        appConfig,
        retrievedMemories,
        searchQuery: keywords.searchQuery,
        searchKeywords: keywords.keywords,
        request: { ...request, identifiers },
        timeline: [
            stepLog(
                'intake',
                'completed',
                Date.now() - t0,
                `App config loaded (${configRow ? 'found' : 'not configured'}), ${retrievedMemories.length} memories; search="${keywords.searchQuery}"`,
            ),
        ],
    };
}
