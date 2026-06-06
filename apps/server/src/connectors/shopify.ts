export async function shopifyAdminQuery(
    shopDomain: string,
    token: string,
    apiVersion: string,
    query: string,
    variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const domain = shopDomain.includes('.') ? shopDomain : `${shopDomain}.myshopify.com`;
    const url = `https://${domain}/admin/api/${apiVersion}/graphql.json`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
        throw new Error(`Shopify API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
    if (data.errors?.length) {
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    return data.data ?? {};
}
