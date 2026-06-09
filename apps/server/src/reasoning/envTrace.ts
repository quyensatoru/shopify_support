import type { Hypothesis, Probe } from '@shopify-support/shared';
import { randomUUID } from 'node:crypto';

/**
 * Env vars are never the terminal root cause — the failure lives in the code
 * that READS them. These helpers (1) detect env-var names implicated by the
 * issue/hypotheses, and (2) generate code probes that locate the read sites so
 * the analysis can trace what breaks downstream when the var is absent/wrong.
 */

// ALL_CAPS_WITH_UNDERSCORE tokens look like env vars (SHOPIFY_API_KEY, REDIS_URL).
const ENV_NAME_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

// All-caps-with-underscore tokens that are common acronyms, not env vars.
const STOPLIST = new Set([
    'HTTP_OK',
    'NOT_FOUND',
    'BAD_REQUEST',
    'TODO_FIXME',
]);

export function detectEnvVars(input: {
    issueText: string;
    hypotheses: Hypothesis[];
    expectedConfig?: Record<string, unknown>;
}): string[] {
    const haystacks: string[] = [input.issueText];
    for (const h of input.hypotheses) {
        haystacks.push(h.statement, h.whyPlausible, ...h.confirmSignals, ...h.rejectSignals);
    }

    const found = new Set<string>();
    for (const text of haystacks) {
        for (const m of text.matchAll(ENV_NAME_RE)) {
            const name = m[0];
            if (!STOPLIST.has(name)) found.add(name);
        }
    }
    // Expected-config keys that look like env vars are strong candidates.
    for (const key of Object.keys(input.expectedConfig ?? {})) {
        if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(key) && !STOPLIST.has(key)) found.add(key);
    }

    return [...found].slice(0, 6);
}

/**
 * Build a `search_code` probe per env var that greps for every read site (the
 * literal name matches the env-schema definition and all usages). Tagged with
 * target.__envTrace so the refine loop knows the trace has already been planned.
 */
export function buildEnvTraceProbes(envVars: string[], hypotheses: Hypothesis[]): Probe[] {
    const hypothesisIds = hypotheses.map((h) => h.id);
    return envVars.map((name) => ({
        id: randomUUID(),
        surface: 'code' as const,
        action: 'search_code',
        target: {
            __envTrace: name,
            glob: '**/*.{ts,js,tsx,jsx,mjs,cjs}',
            // Escape regex metacharacters defensively; env names are [A-Z0-9_] so this is a no-op in practice.
            regex: name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        },
        hint: `Trace where env var ${name} is read in code, to infer the downstream failure it causes (env vars are not a terminal root cause).`,
        hypothesisIds,
        status: 'pending' as const,
    }));
}
