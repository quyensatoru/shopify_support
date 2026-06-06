import { MongoClient } from 'mongodb';
import type { DbAdapter } from './base.adapter.js';

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

  async readSchema(collection: string): Promise<unknown> {
    await this.client.connect();
    const sample = await this.db().collection(collection).find({}).limit(1).toArray();
    if (!sample.length) return {};
    const doc = sample[0]!;
    return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, typeof v]));
  }

  async checkExists(collection: string, query: string): Promise<{ exists: boolean; sample?: unknown }> {
    await this.client.connect();
    // query is a JSON string like '{"shop_domain":"x.myshopify.com"}'
    const filter = JSON.parse(query) as Record<string, unknown>;
    const docs = await this.db().collection(collection).find(filter).limit(3).toArray();
    return { exists: docs.length > 0, sample: docs };
  }

  async count(collection: string, query: string): Promise<number> {
    await this.client.connect();
    const filter = JSON.parse(query) as Record<string, unknown>;
    return this.db().collection(collection).countDocuments(filter);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
