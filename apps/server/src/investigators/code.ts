import type { Probe, ProbeResult, ResolvedAppConfig } from '@shopify-support/shared';
import { cloneOrPull, searchCode, readContext } from '../connectors/gitlab.js';
import {
    ensureIndex,
    buildRepoContext,
    searchSymbols,
    getCallers,
    getCallees,
    getImpact,
} from '../connectors/codegraph.js';
import { getEnv } from '../env.js';
import path from 'node:path';

/**
 * Code investigator.
 *
 * Actions:
 *   search_code      — regex grep over files (glob + regex required)
 *   find_symbol      — find symbol by name via codegraph FTS
 *   find_callers     — get callers of a symbol (by name or nodeId)
 *   find_callees     — get callees of a symbol (by name or nodeId)
 *   impact           — get blast radius of a symbol
 *   build_context    — full codegraph context markdown for a query
 *
 * Planner chooses the most appropriate action based on what it needs to know.
 * All codegraph actions require the repo to have been indexed (done in gather_context).
 */
export async function investigateCode(
    probe: Probe,
    appConfig: ResolvedAppConfig | undefined,
): Promise<ProbeResult> {
    const base = { probeId: probe.id, surface: probe.surface as 'code', action: probe.action };

    if (!appConfig?.repos?.length) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: 'No repos configured',
            provenance: 'code:repos',
        };
    }

    const repoName = probe.target['repo'];
    const repos = repoName
        ? appConfig.repos.filter((r) => r.name === repoName)
        : appConfig.repos.slice(0, 1);

    if (!repos.length) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: `Repo "${repoName}" not found in config`,
            provenance: 'code:repos',
        };
    }

    const workspaceDir = getEnv().WORKSPACE_DIR;
    const repo = repos[0]!;
    const repoPath = path.join(workspaceDir, repo.name);

    // ── action: search_code (regex grep) ──────────────────────────────
    if (probe.action === 'search_code') {
        try {
            await cloneOrPull(repo, repoPath, appConfig.gitlab);
        } catch (err) {
            return {
                ...base,
                status: 'failed',
                found: false,
                data: null,
                reason: `Clone failed: ${String(err)}`,
                provenance: `git:${repo.url}`,
            };
        }

        const glob = probe.target['glob'] ?? '**/*.{ts,js,tsx,jsx,liquid}';
        const regex = probe.target['regex'];

        if (!regex) {
            return {
                ...base,
                status: 'skipped',
                found: false,
                data: null,
                reason: 'No regex provided for search_code',
                provenance: `code:${repo.name}`,
            };
        }

        const matches = await searchCode(repoPath, glob, regex);
        const results: Array<{ repo: string; file: string; line: number; snippet: string }> = [];
        for (const match of matches.slice(0, 10)) {
            const snippet = await readContext(match.file, match.line, 5);
            results.push({
                repo: repo.name,
                file: match.file.replace(repoPath, ''),
                line: match.line,
                snippet,
            });
        }

        return {
            ...base,
            status: 'done',
            found: results.length > 0,
            data: results,
            provenance: `code:search glob=${glob} regex=${regex}`,
        };
    }

    // ── codegraph actions — require ensureIndex ────────────────────────
    let cg;
    try {
        cg = await ensureIndex(repo, repoPath, appConfig.gitlab);
    } catch (err) {
        return {
            ...base,
            status: 'failed',
            found: false,
            data: null,
            reason: `codegraph index failed: ${String(err)}`,
            provenance: `code:${repo.name}`,
        };
    }

    const provenance = `code:codegraph(${repo.name})`;

    // ── action: find_symbol ───────────────────────────────────────────
    if (probe.action === 'find_symbol') {
        const symbol = probe.target['symbol'];
        if (!symbol) {
            return {
                ...base,
                status: 'skipped',
                found: false,
                data: null,
                reason: 'No symbol provided for find_symbol',
                provenance,
            };
        }
        const results = searchSymbols(cg, symbol, 10);
        return {
            ...base,
            status: 'done',
            found: results.length > 0,
            data: results.map((r) => ({
                name: r.node.name,
                file: r.node.filePath ?? '',
                line: r.node.startLine ?? 0,
                kind: r.node.kind,
            })),
            provenance,
        };
    }

    // ── action: find_callers ──────────────────────────────────────────
    if (probe.action === 'find_callers') {
        const nodeId = probe.target['nodeId'];
        const symbol = probe.target['symbol'];
        const depth = Number(probe.target['depth'] ?? 2);

        let targetId = nodeId;
        if (!targetId && symbol) {
            const hits = searchSymbols(cg, symbol, 1);
            targetId = hits[0]?.node.id;
        }
        if (!targetId) {
            return {
                ...base,
                status: 'skipped',
                found: false,
                data: null,
                reason: 'No nodeId or symbol provided for find_callers',
                provenance,
            };
        }

        const callers = getCallers(cg, targetId, depth);
        return {
            ...base,
            status: 'done',
            found: callers.length > 0,
            data: { targetId, callers },
            provenance,
        };
    }

    // ── action: find_callees ──────────────────────────────────────────
    if (probe.action === 'find_callees') {
        const nodeId = probe.target['nodeId'];
        const symbol = probe.target['symbol'];
        const depth = Number(probe.target['depth'] ?? 2);

        let targetId = nodeId;
        if (!targetId && symbol) {
            const hits = searchSymbols(cg, symbol, 1);
            targetId = hits[0]?.node.id;
        }
        if (!targetId) {
            return {
                ...base,
                status: 'skipped',
                found: false,
                data: null,
                reason: 'No nodeId or symbol provided for find_callees',
                provenance,
            };
        }

        const callees = getCallees(cg, targetId, depth);
        return {
            ...base,
            status: 'done',
            found: callees.length > 0,
            data: { targetId, callees },
            provenance,
        };
    }

    // ── action: impact ────────────────────────────────────────────────
    if (probe.action === 'impact') {
        const nodeId = probe.target['nodeId'];
        const symbol = probe.target['symbol'];
        const depth = Number(probe.target['depth'] ?? 3);

        let targetId = nodeId;
        if (!targetId && symbol) {
            const hits = searchSymbols(cg, symbol, 1);
            targetId = hits[0]?.node.id;
        }
        if (!targetId) {
            return {
                ...base,
                status: 'skipped',
                found: false,
                data: null,
                reason: 'No nodeId or symbol provided for impact',
                provenance,
            };
        }

        const impacted = getImpact(cg, targetId, depth);
        return {
            ...base,
            status: 'done',
            found: impacted.length > 0,
            data: { targetId, impacted },
            provenance,
        };
    }

    // ── action: build_context ─────────────────────────────────────────
    if (probe.action === 'build_context') {
        const query = probe.target['symbol'] ?? probe.target['regex'] ?? '';
        const markdown = await buildRepoContext(cg, query);
        return {
            ...base,
            status: 'done',
            found: Boolean(markdown),
            data: { markdown },
            provenance,
        };
    }

    return {
        ...base,
        status: 'skipped',
        found: false,
        data: null,
        reason: `Unknown code action: ${probe.action}`,
        provenance: `code:${repo.name}`,
    };
}
