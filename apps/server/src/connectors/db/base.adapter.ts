export interface DbAdapter {
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
