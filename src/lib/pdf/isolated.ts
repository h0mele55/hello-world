import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Runs code that reads an untrusted PDF in a child process of its own (#154):
 * pdf.js for parsing (parse-child.mjs) and pdf-lib for the incremental updates
 * the worker writes (edit-child.mjs). This is the only place the server starts
 * a child.
 *
 * - A heap cap (`--max-old-space-size`) and a memory cap on the whole process:
 *   the heap cap does not count the ArrayBuffers a decompression bomb inflates
 *   into, so the child's resident memory is read from /proc while it runs and
 *   the child is killed once past the cap. Where there is no /proc, the heap
 *   cap and the timeout still hold.
 * - A timeout, after which the child is killed.
 * - An empty environment: no issuer key, seal credential, file key or
 *   database URL reaches code a hostile PDF may control.
 * - At most ISOLATED_CONCURRENCY children at once; the rest wait their turn,
 *   and their timeout starts when they do.
 *
 * Every outcome is the child's answer or a named reason; the caller checks the
 * answer's shape.
 */

export interface IsolationLimits {
  timeoutMs: number;
  /** The child's V8 heap. */
  heapMb: number;
  /** The child's resident memory, heap and ArrayBuffers together. */
  memoryMb: number;
}

export type IsolatedOutcome = { ok: true; answer: unknown } | { ok: false; reason: 'TIMEOUT' | 'RESOURCE_LIMIT' | 'CRASHED'; detail?: string };

/** Children running at once: each may use up to its memory cap. */
export const ISOLATED_CONCURRENCY = 2;
const MEMORY_POLL_MS = 20;

// How a V8 out-of-memory abort ends a process: SIGTRAP or SIGABRT on Unix
// (Node 22 traps), a breakpoint or fast-fail status on Windows.
const OOM_SIGNALS = new Set(['SIGTRAP', 'SIGABRT']);
const OOM_EXIT_CODES = new Set([133, 134, 0x80000003, 0xc0000409]);

let active = 0;
let peak = 0;
const waiting: (() => void)[] = [];

/** For tests and the monitor: children running, waiting, and the most that ever ran at once. */
export const isolationStats = () => ({ active, waiting: waiting.length, peak });

async function turn(): Promise<() => void> {
  if (active >= ISOLATED_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  peak = Math.max(peak, active);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    waiting.shift()?.();
  };
}

/** The child's resident memory in bytes, or null where it cannot be read. */
function residentBytes(pid: number): number | null {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'latin1'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** Nothing from the server's environment; on Windows only the system root, without which Node cannot start its crypto. */
const childEnv = (): Record<string, string> => (process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {});

/**
 * A script that lives in the source tree and runs under plain Node. The
 * bundler is told to leave the path alone: the script must run as its own
 * process, not be bundled into the server.
 */
export function childScriptPath(name: string): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'lib', 'pdf', name);
}

export async function runIsolated(script: string, message: unknown, limits: IsolationLimits): Promise<IsolatedOutcome> {
  const release = await turn();
  try {
    return await runChild(script, message, limits);
  } finally {
    release();
  }
}

function runChild(script: string, message: unknown, limits: IsolationLimits): Promise<IsolatedOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let killedFor: 'TIMEOUT' | 'RESOURCE_LIMIT' | null = null;
    const child = fork(script, [], {
      execArgv: [`--max-old-space-size=${limits.heapMb}`],
      // Not even NODE_ENV: the type Next.js gives ProcessEnv asks for one, the child needs none.
      env: childEnv() as NodeJS.ProcessEnv,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const settle = (outcome: IsolatedOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve(outcome);
    };
    const stop = (reason: 'TIMEOUT' | 'RESOURCE_LIMIT') => {
      killedFor = reason;
      settle({ ok: false, reason });
    };
    const timer = setTimeout(() => stop('TIMEOUT'), limits.timeoutMs);
    const watch = setInterval(() => {
      const rss = child.pid === undefined ? null : residentBytes(child.pid);
      if (rss !== null && rss > limits.memoryMb * 1024 * 1024) stop('RESOURCE_LIMIT');
    }, MEMORY_POLL_MS);

    child.once('message', (answer) => settle({ ok: true, answer }));
    child.once('error', () => settle({ ok: false, reason: 'CRASHED', detail: 'could not start the child' }));
    // 'close', not 'exit': it fires only after the IPC channel has drained, so
    // an answer sent just before exiting is never mistaken for a crash.
    child.once('close', (code, signal) => {
      if (killedFor) return;
      if ((signal !== null && OOM_SIGNALS.has(signal)) || (code !== null && OOM_EXIT_CODES.has(code >>> 0))) {
        settle({ ok: false, reason: 'RESOURCE_LIMIT' });
      } else {
        settle({ ok: false, reason: 'CRASHED', detail: `exit ${code ?? signal}` });
      }
    });
    child.send(message as object);
  });
}
