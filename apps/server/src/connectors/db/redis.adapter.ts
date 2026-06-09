import { Redis } from 'ioredis';
import type { DbAdapter, DbEntity } from './base.adapter.js';

export class RedisAdapter implements DbAdapter {
    private client: Redis;

    constructor(connectionString: string) {
        this.client = new Redis(connectionString, { lazyConnect: true });
    }

    async listEntities(): Promise<DbEntity[]> {
        await this.client.connect();
        // Redis has no schema; the closest analogue is the key-namespace
        // (prefix before the first ':'). SCAN a bounded sample to learn them.
        const namespaces = new Map<string, number>();
        let cursor = '0';
        let scanned = 0;
        do {
            const [next, keys] = await this.client.scan(cursor, 'COUNT', 200);
            cursor = next;
            for (const key of keys) {
                const ns = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
                namespaces.set(ns, (namespaces.get(ns) ?? 0) + 1);
            }
            scanned += keys.length;
        } while (cursor !== '0' && scanned < 2000);

        return [...namespaces.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([name, approxCount]) => ({ name: `${name}:*`, kind: 'keyspace' as const, approxCount }));
    }

    async readSchema(_target: string): Promise<unknown> {
        return { note: 'Redis has no schema — use key_inspect to inspect specific keys' };
    }

    async checkExists(
        _target: string,
        key: string,
    ): Promise<{ exists: boolean; sample?: unknown }> {
        await this.client.connect();
        const exists = await this.client.exists(key);
        const value = exists ? await this.client.get(key) : null;
        return { exists: exists > 0, sample: value };
    }

    async count(_target: string, pattern: string): Promise<number> {
        await this.client.connect();
        const keys = await this.client.keys(pattern);
        return keys.length;
    }

    async keyInspect(pattern: string): Promise<unknown> {
        await this.client.connect();
        const keys = await this.client.keys(pattern);
        if (!keys.length) return null;
        const results: Array<{ key: string; type: string; ttl: number; value?: string }> = [];
        for (const key of keys.slice(0, 5)) {
            const type = await this.client.type(key);
            const ttl = await this.client.ttl(key);
            const value =
                type === 'string' ? ((await this.client.get(key)) ?? undefined) : undefined;
            results.push({ key, type, ttl, value });
        }
        return results;
    }

    async close(): Promise<void> {
        this.client.disconnect();
    }
}
