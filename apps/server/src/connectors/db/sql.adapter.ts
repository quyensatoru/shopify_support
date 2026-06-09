import pg from 'pg';
import type { DbAdapter, DbEntity } from './base.adapter.js';
import { assertReadOnlyWhere } from './readonly.guard.js';

export class SqlAdapter implements DbAdapter {
    private pool: pg.Pool;

    constructor(connectionString: string) {
        this.pool = new pg.Pool({ connectionString, max: 3 });
    }

    /**
     * Run a SELECT inside a READ ONLY transaction. Any write attempted by the
     * statement (or a chained one that slipped past the guard) raises
     * "cannot execute ... in a read-only transaction" at the database level.
     */
    private async runReadOnly(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN TRANSACTION READ ONLY');
            const res = await client.query(text, params);
            await client.query('ROLLBACK');
            return res;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async listEntities(): Promise<DbEntity[]> {
        // One pass over information_schema: every base table in user schemas with
        // its columns, plus an approximate row count from pg_class.reltuples.
        const res = await this.runReadOnly(
            `SELECT c.table_name,
                    c.column_name,
                    c.data_type,
                    COALESCE(pc.reltuples, 0)::bigint AS approx_count
             FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.table_schema = c.table_schema AND t.table_name = c.table_name
             LEFT JOIN pg_class pc ON pc.relname = c.table_name
             WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
               AND t.table_type = 'BASE TABLE'
             ORDER BY c.table_name, c.ordinal_position`,
        );

        const byTable = new Map<string, DbEntity>();
        for (const row of res.rows as Array<{
            table_name: string;
            column_name: string;
            data_type: string;
            approx_count: string;
        }>) {
            let entity = byTable.get(row.table_name);
            if (!entity) {
                entity = {
                    name: row.table_name,
                    kind: 'table',
                    columns: [],
                    approxCount: Number(row.approx_count) || 0,
                };
                byTable.set(row.table_name, entity);
            }
            entity.columns!.push({ name: row.column_name, type: row.data_type });
        }
        // Cap to keep the reasoning prompt bounded.
        return [...byTable.values()].slice(0, 60);
    }

    async readSchema(table: string): Promise<unknown> {
        const res = await this.runReadOnly(
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
        // whereClause is a synthesized string like "shop_domain = 'x.myshopify.com'".
        // Guard rejects DML/DDL/statement-chaining; the READ ONLY tx is the backstop.
        assertReadOnlyWhere(whereClause);
        const clause = whereClause.trim() || 'true';
        const q = `SELECT * FROM ${pg.escapeIdentifier(table)} WHERE ${clause} LIMIT 3`;
        const res = await this.runReadOnly(q);
        return { exists: res.rows.length > 0, sample: res.rows };
    }

    async count(table: string, whereClause: string): Promise<number> {
        assertReadOnlyWhere(whereClause);
        const clause = whereClause.trim() || 'true';
        const q = `SELECT COUNT(*) AS n FROM ${pg.escapeIdentifier(table)} WHERE ${clause}`;
        const res = await this.runReadOnly(q);
        return Number(res.rows[0]?.n ?? 0);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}
