import { Redis } from 'ioredis';
import type { DbAdapter } from './base.adapter.js';

export class RedisAdapter implements DbAdapter {
    private client: Redis;

    constructor(connectionString: string) {
        this.client = new Redis(connectionString, { lazyConnect: true });
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
