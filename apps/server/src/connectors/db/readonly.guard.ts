/**
 * Read-only guards for synthesized queries.
 *
 * These run in addition to (not instead of) the SQL READ ONLY transaction and
 * Mongo find/count-only access. They are a second line of defense against an
 * LLM-synthesized clause that tries to mutate or chain statements.
 */

const FORBIDDEN_SQL = [
    'insert',
    'update',
    'delete',
    'drop',
    'alter',
    'truncate',
    'create',
    'grant',
    'revoke',
    'merge',
    'call',
    'do',
    'copy',
    'vacuum',
    'comment',
    'execute',
    'commit',
    'rollback',
    'savepoint',
    'set ',
    'reset ',
    'pg_sleep',
    'pg_read_file',
    'lo_import',
    'lo_export',
];

/**
 * Validate a SQL WHERE clause that will be interpolated into
 * `SELECT ... FROM <table> WHERE <clause>`. Rejects statement chaining and any
 * DML/DDL keyword. Throws on violation.
 */
export function assertReadOnlyWhere(clause: string): void {
    const c = clause.trim();
    if (!c) return; // empty clause is handled by the caller (defaults to a bounded scan)
    if (c.includes(';')) {
        throw new Error('Read-only guard: ";" (statement chaining) is not allowed in a WHERE clause');
    }
    if (/--|\/\*|\*\//.test(c)) {
        throw new Error('Read-only guard: SQL comments are not allowed in a WHERE clause');
    }
    const lower = ` ${c.toLowerCase()} `;
    for (const kw of FORBIDDEN_SQL) {
        const needle = kw.endsWith(' ') ? kw : `${kw} `;
        if (lower.includes(` ${needle}`) || lower.includes(`(${needle}`)) {
            throw new Error(`Read-only guard: forbidden keyword "${kw.trim()}" in WHERE clause`);
        }
    }
}

const FORBIDDEN_MONGO_OPERATORS = ['$where', '$function', '$accumulator', '$expr'];

/**
 * Parse and sanitize a Mongo filter passed as a JSON string. Strips operators
 * that can execute server-side JavaScript. Throws on invalid JSON.
 */
export function parseReadOnlyMongoFilter(query: string): Record<string, unknown> {
    const trimmed = query.trim();
    if (!trimmed) return {};
    let filter: unknown;
    try {
        filter = JSON.parse(trimmed);
    } catch {
        throw new Error(`Read-only guard: Mongo filter must be valid JSON, got: ${trimmed.slice(0, 120)}`);
    }
    const serialized = JSON.stringify(filter).toLowerCase();
    for (const op of FORBIDDEN_MONGO_OPERATORS) {
        if (serialized.includes(op)) {
            throw new Error(`Read-only guard: forbidden Mongo operator "${op}" in filter`);
        }
    }
    return (filter ?? {}) as Record<string, unknown>;
}
