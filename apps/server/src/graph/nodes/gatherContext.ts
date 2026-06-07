import type { SupportStateType } from '../state.js';
import { ensureIndex, buildRepoContext, detectExpectedMarkers, searchSymbols } from '../../connectors/codegraph.js';
import { retrieveAppKnowledge, learnApp, hasAppKnowledge } from '../../knowledge/index.js';
import { stepLog } from '../utils.js';
import { getEnv } from '../../env.js';
import { logger } from '../../observability/logger.js';
import path from 'node:path';
import type { CodeContext, AppKnowledgeChunk } from '@shopify-support/shared';

/**
 * gather_context node — deterministic, runs between intake and planner.
 *
 * In parallel:
 * 1. Code index: for each configured repo, cloneOrPull + open/sync codegraph,
 *    then buildContext(issueText) → codeContexts.
 * 2. App knowledge: retrieve top-k chunks from pgvector.
 *    On first run (no chunks in DB): learnApp() inline → then retrieve.
 *
 * No LLM is called here. All output is deterministic.
 */
export async function gatherContextNode(state: SupportStateType) {
    const t0 = Date.now();
    const { request, appConfig } = state;
    const appKey = request.appKey ?? request.app;

    // Run code indexing and app knowledge retrieval in parallel
    const [codeContextResults, appKnowledge] = await Promise.all([
        // ── 1. Code index ─────────────────────────────────────────────
        appConfig?.repos?.length && appConfig.gitlab
            ? Promise.all(
                  appConfig.repos.map(async (repo): Promise<CodeContext | null> => {
                      const workspaceDir = getEnv().WORKSPACE_DIR;
                      const repoPath = path.join(workspaceDir, repo.name);
                      try {
                          const cg = await ensureIndex(repo, repoPath, appConfig!.gitlab!);
                          const [contextMarkdown, markers, topSymbols] = await Promise.all([
                              buildRepoContext(cg, request.issueText),
                              Promise.resolve(detectExpectedMarkers(cg)),
                              Promise.resolve(
                                  searchSymbols(cg, request.issueText.split(' ').slice(0, 3).join(' '), 10),
                              ),
                          ]);
                          const frameworks = cg.getDetectedFrameworks();
                          return {
                              repo: repo.name,
                              framework: frameworks[0],
                              contextMarkdown: contextMarkdown ?? '(codegraph context unavailable)',
                              relevantSymbols: topSymbols.map((r) => ({
                                  name: r.node.name,
                                  file: r.node.filePath ?? '',
                                  kind: r.node.kind,
                                  line: r.node.startLine ?? undefined,
                              })),
                              expectedMarkers: markers,
                          };
                      } catch (err) {
                          logger.error({ err, repo: repo.name }, 'gather_context: codegraph failed for repo');
                          return null;
                      }
                  }),
              )
            : Promise.resolve([] as Array<CodeContext | null>),

        // ── 2. App knowledge ─────────────────────────────────────────
        (async (): Promise<AppKnowledgeChunk[]> => {
            try {
                const known = await hasAppKnowledge(appKey);
                const hasSource = appConfig && (
                    (appConfig.docUrls ?? []).length > 0 ||
                    !!appConfig.homepage ||
                    !!appConfig.appStoreUrl
                );
                if (!known && hasSource && appConfig) {
                    logger.info({ appKey }, 'gather_context: first run — learning app inline');
                    await learnApp(appKey, appConfig);
                }
                const chunks = await retrieveAppKnowledge(appKey, request.issueText, 5);
                return chunks ?? [];
            } catch (err) {
                logger.warn({ err, appKey }, 'gather_context: appKnowledge retrieval failed (non-fatal)');
                return [];
            }
        })(),
    ]);

    const codeContexts = (codeContextResults as Array<CodeContext | null>).filter(
        (c): c is CodeContext => c !== null,
    );
    const symbolCount = codeContexts.reduce((s, c) => s + c.relevantSymbols.length, 0);
    const markerCount = codeContexts.reduce((s, c) => s + c.expectedMarkers.length, 0);

    return {
        codeContexts,
        appKnowledge,
        timeline: [
            stepLog(
                'gather_context',
                'completed',
                Date.now() - t0,
                `${codeContexts.length} repos indexed; ${symbolCount} symbols, ${markerCount} markers; ${appKnowledge.length} knowledge chunks`,
            ),
        ],
    };
}
