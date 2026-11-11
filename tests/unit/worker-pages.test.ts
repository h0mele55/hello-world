import { describe, expect, it } from 'vitest';
import { PAGE_ROWS, pagesOf } from '@/lib/anchoring/worker';

/** A query over `rows` in order, answering a page after the cursor, as Prisma's cursor and skip do. */
function finder(rows: { id: string }[]) {
  const calls: (string | undefined)[] = [];
  const find = async (cursor: string | undefined) => {
    calls.push(cursor);
    const from = cursor === undefined ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
    return rows.slice(from, from + PAGE_ROWS);
  };
  return { find, calls };
}

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('the worker’s paged reads (#139)', () => {
  it('reaches rows behind any number of rows that fail every pass, which one fixed page never did', async () => {
    const rows = Array.from({ length: 3 * PAGE_ROWS + 7 }, (_, i) => ({ id: `row-${String(i).padStart(4, '0')}` }));
    const { find, calls } = finder(rows);
    const seen = await all(pagesOf(find, 1000));
    expect(seen.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(calls).toEqual([undefined, rows[PAGE_ROWS - 1].id, rows[2 * PAGE_ROWS - 1].id, rows[3 * PAGE_ROWS - 1].id]);
  });

  it('stops after the scan limit, a whole page at a time, and reads nothing for an empty query', async () => {
    const rows = Array.from({ length: 4 * PAGE_ROWS }, (_, i) => ({ id: `row-${i}` }));
    expect(await all(pagesOf(finder(rows).find, PAGE_ROWS + 1))).toHaveLength(2 * PAGE_ROWS);
    const empty = finder([]);
    expect(await all(pagesOf(empty.find, 500))).toEqual([]);
    expect(empty.calls).toEqual([undefined]);
  });
});
