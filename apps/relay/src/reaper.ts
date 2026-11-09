import type { DatabaseSync } from 'node:sqlite';
import type { Cloudflare } from './cloudflare.ts';
import { removeComputer } from './link.ts';

export interface ReapOptions {
  dryRun: boolean; // log what would go, delete nothing
  afterSeconds: number; // a tunnel that has not been healthy this long is dead
}

// One sweep. A tunnel that is healthy resets its clock. A tunnel Cloudflare no longer has (null) is dead at once.
// ponytail: runs over every row each sweep; fine for a few hundred computers, page it when that stops being true.
export async function reap(
  d: { db: DatabaseSync; cf: Cloudflare; now: () => number },
  opts: ReapOptions,
): Promise<{ id: string; action: 'kept' | 'would-remove' | 'removed' | 'failed' }[]> {
  const now = d.now();
  const rows = d.db.prepare('SELECT id, tunnel_id, dns_id, idle_since, created_at FROM computers').all() as unknown as {
    id: string;
    tunnel_id: string;
    dns_id: string;
    idle_since: number | null;
    created_at: number;
  }[];
  const out: { id: string; action: 'kept' | 'would-remove' | 'removed' | 'failed' }[] = [];
  for (const row of rows) {
    // A row with no tunnel yet is a link in progress (link.ts reserves it first). Past the window, the link was cut
    // short (a crash before the tunnel was saved), so the row goes; it would otherwise count against the limit forever.
    if (!row.tunnel_id) {
      if (now - row.created_at < opts.afterSeconds) {
        out.push({ id: row.id, action: 'kept' });
        continue;
      }
      if (opts.dryRun) {
        console.log('reap (dry run): would remove', row.id, 'unfinished');
        out.push({ id: row.id, action: 'would-remove' });
        continue;
      }
      try {
        await removeComputer(d, row);
        out.push({ id: row.id, action: 'removed' });
      } catch (e) {
        console.error('reap: remove failed', row.id, (e as Error).message);
        out.push({ id: row.id, action: 'failed' });
      }
      continue;
    }
    let status: string | null;
    try {
      status = await d.cf.tunnelStatus(row.tunnel_id);
    } catch (e) {
      console.error('reap: status failed', row.id, (e as Error).message);
      out.push({ id: row.id, action: 'failed' });
      continue;
    }
    if (status === 'healthy') {
      if (row.idle_since !== null) d.db.prepare('UPDATE computers SET idle_since = NULL WHERE id = ?').run(row.id);
      out.push({ id: row.id, action: 'kept' });
      continue;
    }
    const since = row.idle_since ?? now;
    if (row.idle_since === null) d.db.prepare('UPDATE computers SET idle_since = ? WHERE id = ?').run(now, row.id);
    if (status !== null && now - since < opts.afterSeconds) {
      out.push({ id: row.id, action: 'kept' });
      continue;
    }
    if (opts.dryRun) {
      console.log('reap (dry run): would remove', row.id, status ?? 'gone');
      out.push({ id: row.id, action: 'would-remove' });
      continue;
    }
    try {
      await removeComputer(d, row);
      console.log('reap: removed', row.id, status ?? 'gone');
      out.push({ id: row.id, action: 'removed' });
    } catch (e) {
      console.error('reap: remove failed', row.id, (e as Error).message);
      out.push({ id: row.id, action: 'failed' });
    }
  }
  return out;
}
