import { MongoClient } from 'mongodb';
import type { DbAdapter, DbEntity } from './base.adapter.js';
import { parseReadOnlyMongoFilter } from './readonly.guard.js';

export class MongoAdapter implements DbAdapter {
    private client: MongoClient;
    private dbName: string;

    constructor(connectionString: string) {
        this.client = new MongoClient(connectionString);
        // Extract db name from connection string or default
        const urlMatch = connectionString.match(/\/([^/?]+)(\?|$)/);
        this.dbName = urlMatch?.[1] ?? 'default';
    }

    private db() {
        return this.client.db(this.dbName);
    }

    async healthCheck(): Promise<boolean> {
        try {
            await this.client.db('admin').command({ ping: 1 });
            return true;
        } catch {
            return false;
        }
    }

    async listEntities(): Promise<DbEntity[]> {
        await this.client.connect();
        const collections = await this.db().listCollections({}, { nameOnly: true }).toArray();
        const names = collections
            .map((c) => c.name)
            .filter((n) => !n.startsWith('system.'))
            .slice(0, 40);

        const entities: DbEntity[] = [];
        for (const name of names) {
            // Infer a field-level schema from one sample document.
            const sample = await this.db().collection(name).find({}).limit(1).toArray();
            const columns = sample.length
                ? Object.entries(sample[0]!).map(([k, v]) => ({
                      name: k,
                      type: Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v,
                  }))
                : [];
            entities.push({ name, kind: 'collection', columns });
        }
        return entities;
    }

    async readSchema(collection: string): Promise<unknown> {
        await this.client.connect();
        const sample = await this.db().collection(collection).find({}).limit(1).toArray();
        if (!sample.length) return {};
        const doc = sample[0]!;
        return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, typeof v]));
    }

    async checkExists(
        collection: string,
        query: string,
    ): Promise<{ exists: boolean; sample?: unknown }> {
        await this.client.connect();
        // query is a JSON string like '{"shop_domain":"x.myshopify.com"}'.
        // Guard strips server-side-JS operators ($where, $function, ...).
        const filter = parseReadOnlyMongoFilter(query);
        const docs = await this.db().collection(collection).find(filter).limit(3).toArray();
        return { exists: docs.length > 0, sample: docs };
    }

    async count(collection: string, query: string): Promise<number> {
        await this.client.connect();
        const filter = parseReadOnlyMongoFilter(query);
        return this.db().collection(collection).countDocuments(filter);
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}
