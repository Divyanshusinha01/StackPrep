import pg from "pg";

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Postgres access through a shared connection pool. */
export class Database implements Queryable {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, maxConnections = 10) {
    this.pool = new pg.Pool({ connectionString, max: maxConnections });
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  /** Runs `fn` inside BEGIN/COMMIT on one connection; any thrown error rolls back. */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      query: async <R>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as R[],
    };
    try {
      await client.query("BEGIN");
      const value = await fn(tx);
      await client.query("COMMIT");
      return value;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
