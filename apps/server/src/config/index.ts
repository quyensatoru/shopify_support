import type { ResolvedAppConfig } from '@shopify-support/shared';
import { decrypt, isEncrypted } from './crypto.js';
import type { AppConfigRow } from '../db/repo/index.js';

function maybeDecrypt(value: string | undefined | null): string {
    if (!value) return '';
    return isEncrypted(value) ? decrypt(value) : value;
}

export function resolveAppConfig(row: AppConfigRow): ResolvedAppConfig {
    const cfg = row.config as Record<string, unknown>;

    const repos = ((cfg['repos'] as unknown[]) ?? []).map((r) => {
        const repo = r as Record<string, string>;
        return {
            name: repo['name'] ?? '',
            gitlabProjectId: repo['gitlabProjectId'],
            url: repo['url'] ?? '',
            branch: repo['branch'] ?? 'main',
        };
    });

    const gitlab = cfg['gitlab'] as { baseUrl: string; token: string } | undefined;

    const dbSources = ((cfg['dbSources'] as unknown[]) ?? []).map((s) => {
        const src = s as Record<string, string>;
        return {
            key: src['key'] ?? '',
            type: src['type'] as 'sql' | 'mongo' | 'redis' | 'rabbitmq',
            connectionString: maybeDecrypt(src['connectionString']),
            mgmtUrl: src['mgmtUrl'] ? maybeDecrypt(src['mgmtUrl']) : undefined,
            readOnly: true as const,
        };
    });

    const logSources = cfg['logSources']
        ? ((cfg['logSources'] as unknown[]) ?? []).map((s) => {
              const src = s as Record<string, string>;
              return {
                  key: src['key'] ?? '',
                  type: src['type'] ?? '',
                  endpoint: maybeDecrypt(src['endpoint']),
                  token: src['token'] ? maybeDecrypt(src['token']) : undefined,
              };
          })
        : undefined;

    const shopify = cfg['shopify'] as
        | {
              apiVersion: string;
              adminToken?: string;
              requiredScopes?: string[];
              expectedWebhooks?: string[];
          }
        | undefined;

    const services = ((cfg['services'] as unknown[]) ?? []).map((s) => {
        const svc = s as Record<string, string>;
        return {
            key: svc['key'] ?? '',
            baseUrl: svc['baseUrl'] ?? '',
            token: svc['token'] ? maybeDecrypt(svc['token']) : undefined,
        };
    });

    return {
        appKey: row.appKey,
        name: row.name,
        repos,
        gitlab: gitlab ? { baseUrl: gitlab.baseUrl, token: maybeDecrypt(gitlab.token) } : undefined,
        dbSources,
        logSources,
        shopify: shopify
            ? {
                  apiVersion: shopify.apiVersion,
                  adminToken: shopify.adminToken ? maybeDecrypt(shopify.adminToken) : undefined,
                  requiredScopes: shopify.requiredScopes ?? [],
                  expectedWebhooks: shopify.expectedWebhooks ?? [],
              }
            : undefined,
        services,
        expectedConfig: (cfg['expectedConfig'] as Record<string, unknown>) ?? {},
        appStoreUrl: (cfg['appStoreUrl'] as string | undefined) || undefined,
        docUrls: (cfg['docUrls'] as string[] | undefined) ?? [],
        homepage: (cfg['homepage'] as string | undefined) || undefined,
        appDescription: (cfg['appDescription'] as string | undefined) || undefined,
    };
}
