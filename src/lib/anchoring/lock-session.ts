import pg from 'pg';

/**
 * The dedicated database session that holds the issuer's advisory lock (#156).
 * The lock lives as long as the session, so the session is watched:
 *
 * - TCP keepalives, so a connection a firewall or Postgres drops while idle
 *   is noticed rather than left half-open;
 * - an 'error' listener: pg emits 'error' on a client whose connection ends
 *   while idle (a Postgres restart, an idle-connection kill), and with no
 *   listener that error is unhandled and kills the worker mid-step. Here it
 *   marks the session `lost` instead.
 *
 * A lost session means the lock is gone: Postgres released it with the
 * session, and another worker may hold it now. The worker checks `lost`
 * before it signs and before it sends, and ends the pass by name. The next
 * query opens a fresh session, so the next pass takes the lock again.
 */
/** What the worker needs of the lock's session: a plain pg.Client is one, without `lost`. */
export interface LockClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
  readonly lost?: boolean;
}

export interface LockSession extends LockClient {
  /** The session holding the lock ended since it was opened. */
  readonly lost: boolean;
  end(): Promise<void>;
}

export function createLockSession(connectionString: string, applicationName = 'anchor-issuer-lock'): LockSession {
  let client: pg.Client | null = null;
  let lost = false;
  const open = async () => {
    if (client) return client;
    const fresh = new pg.Client({ connectionString, keepAlive: true, keepAliveInitialDelayMillis: 10_000, application_name: applicationName });
    fresh.on('error', () => {
      lost = true;
      if (client === fresh) client = null;
      fresh.end().catch(() => {});
    });
    await fresh.connect();
    client = fresh;
    lost = false;
    return fresh;
  };
  return {
    get lost() {
      return lost;
    },
    async query<R extends pg.QueryResultRow>(text: string, values?: unknown[]) {
      const session = await open();
      return session.query<R>(text, values);
    },
    async end() {
      const session = client;
      client = null;
      await session?.end();
    },
  };
}
