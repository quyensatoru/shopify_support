/** A discoverable entity in a data source: a SQL table, a Mongo collection,
 *  a Redis key-namespace, or a message queue. Columns are populated where the
 *  source can introspect them cheaply (SQL, Mongo) so downstream reasoning can
 *  build a grounded read-only query without a second round-trip. */
export interface DbEntity {
    name: string;
    kind: 'table' | 'collection' | 'keyspace' | 'queue';
    columns?: Array<{ name: string; type: string }>;
    approxCount?: number;
}

export interface DbAdapter {
    /** List tables / collections / key-namespaces / queues with cheap schema. */
    listEntities(): Promise<DbEntity[]>;
    readSchema(target: string): Promise<unknown>;
    checkExists(target: string, query: string): Promise<{ exists: boolean; sample?: unknown }>;
    count(target: string, query: string): Promise<number>;
    /** Redis only */
    keyInspect?(pattern: string): Promise<unknown>;
    /** RabbitMQ only */
    queueInspect?(queue: string): Promise<unknown>;
    peekMessages?(queue: string, n: number): Promise<unknown[]>;
    close(): Promise<void>;
}
