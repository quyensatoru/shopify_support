import pg from 'pg';
import type { DbAdapter } from './base.adapter.js';

export class SqlAdapter implements DbAdapter {
    private pool: pg.Pool;

    constructor(connectionString: string) {
        this.pool = new pg.Pool({ connectionString, max: 3 });
    }

    async readSchema(table: string): Promise<unknown> {
        const res = await this.pool.query(
            `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = $1
       ORDER BY ordinal_position`,
            [table],
        );
        return res.rows;
    }

    async checkExists(
        table: string,
        whereClause: string,
    ): Promise<{ exists: boolean; sample?: unknown }> {
        // whereClause is a safe templated string like "shop_domain = 'x.myshopify.com'"
        // Only SELECTs are allowed — no mutations
        const q = `SELECT * FROM ${pg.escapeIdentifier(table)} WHERE ${whereClause} LIMIT 3`;
        const res = await this.pool.query(q);
        return { exists: res.rows.length > 0, sample: res.rows };
    }

    async count(table: string, whereClause: string): Promise<number> {
        const q = `SELECT COUNT(*) AS n FROM ${pg.escapeIdentifier(table)} WHERE ${whereClause}`;
        const res = await this.pool.query(q);
        return Number(res.rows[0]?.n ?? 0);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}
