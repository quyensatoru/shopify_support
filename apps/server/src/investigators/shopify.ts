import type { Probe, ProbeResult, ResolvedAppConfig, RunRequest } from '@shopify-support/shared';
import { shopifyAdminQuery } from '../connectors/shopify.js';

export async function investigateShopify(
    probe: Probe,
    appConfig: ResolvedAppConfig | undefined,
    request: RunRequest,
): Promise<ProbeResult> {
    const base = { probeId: probe.id, surface: probe.surface as 'shopify', action: probe.action };
    const shopDomain = request.storeDomain ?? probe.target['url'];

    if (!appConfig?.shopify?.adminToken) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: 'Shopify adminToken not configured',
            provenance: 'shopify:config',
        };
    }
    if (!shopDomain) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: 'Store domain required for Shopify probe',
            provenance: 'shopify:missing_domain',
        };
    }

    const { adminToken, apiVersion } = appConfig.shopify;
    const provenance = `shopify:${shopDomain}/${probe.action}`;

    try {
        switch (probe.action) {
            case 'app_status': {
                const data = await shopifyAdminQuery(
                    shopDomain,
                    adminToken,
                    apiVersion,
                    `{ app { id title } }`,
                );
                return { ...base, status: 'done', found: Boolean(data?.app), data, provenance };
            }
            case 'granted_scopes': {
                const data = (await shopifyAdminQuery(
                    shopDomain,
                    adminToken,
                    apiVersion,
                    `{ appInstallation { accessScopes { handle } } }`,
                )) as { appInstallation?: { accessScopes?: Array<{ handle: string }> } };
                const granted = (data.appInstallation?.accessScopes ?? []).map((s) => s.handle);
                const required = appConfig.shopify.requiredScopes;
                const missing = required.filter((s) => !granted.includes(s));
                return {
                    ...base,
                    status: 'done',
                    found: missing.length === 0,
                    data: { granted, missing },
                    provenance,
                };
            }
            case 'list_webhooks': {
                const data = (await shopifyAdminQuery(
                    shopDomain,
                    adminToken,
                    apiVersion,
                    `{ webhookSubscriptions(first: 50) { edges { node { id topic endpoint { __typename } } } } }`,
                )) as { webhookSubscriptions?: { edges?: Array<{ node: { topic?: string } }> } };
                const subs = (data.webhookSubscriptions?.edges ?? []).map((e) => e.node);
                const expected = appConfig.shopify.expectedWebhooks;
                const topics = subs.map((s) => s.topic ?? '');
                const missingWebhooks = expected.filter((w) => !topics.includes(w));
                return {
                    ...base,
                    status: 'done',
                    found: missingWebhooks.length === 0,
                    data: { subscriptions: subs, missing: missingWebhooks },
                    provenance,
                };
            }
            case 'billing_status': {
                const data = (await shopifyAdminQuery(
                    shopDomain,
                    adminToken,
                    apiVersion,
                    `{ appInstallation { activeSubscriptions { id name status } } }`,
                )) as {
                    appInstallation?: {
                        activeSubscriptions?: Array<{ id: string; name: string; status: string }>;
                    };
                };
                const active = (data.appInstallation?.activeSubscriptions ?? []).filter(
                    (s) => s.status === 'ACTIVE',
                );
                return {
                    ...base,
                    status: 'done',
                    found: active.length > 0,
                    data: { activeSubscriptions: active },
                    provenance,
                };
            }
            case 'graphql_probe': {
                const q = probe.target['query'];
                if (!q)
                    return {
                        ...base,
                        status: 'skipped',
                        found: false,
                        data: null,
                        reason: 'No query provided',
                        provenance,
                    };
                const data = await shopifyAdminQuery(shopDomain, adminToken, apiVersion, q);
                return { ...base, status: 'done', found: true, data, provenance };
            }
            default:
                return {
                    ...base,
                    status: 'skipped',
                    found: false,
                    data: null,
                    reason: `Unknown shopify action: ${probe.action}`,
                    provenance,
                };
        }
    } catch (err) {
        return {
            ...base,
            status: 'failed',
            found: false,
            data: null,
            reason: String(err),
            provenance,
        };
    }
}
