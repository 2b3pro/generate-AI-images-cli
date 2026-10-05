import fs from 'fs';
import os from 'os';
import path from 'path';
import type { JobRecord, ModelKind } from '../types';

export const DEFAULT_WAIT_SECONDS: Record<ModelKind, number> = { image: 120, video: 600, audio: 300 };
export const POLL_INTERVAL_MS: Record<ModelKind, number> = { image: 2000, video: 5000, audio: 5000 };
const MAX_BACKOFF_MS = 30000;

export function jobsDir(): string {
  const override = process.env.GENERATE_JOBS_DIR?.trim();
  if (override) return override;
  const cache = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(cache, 'generate', 'jobs');
}

function jobPath(id: string): string {
  return path.join(jobsDir(), `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/** Write via temp file + rename so concurrent readers never see a partial record. */
export function writeJob(rec: JobRecord): void {
  fs.mkdirSync(jobsDir(), { recursive: true });
  const target = jobPath(rec.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, target);
}

export function readJob(id: string): JobRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')) as JobRecord;
  } catch {
    return undefined;
  }
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord {
  const current = readJob(id);
  if (!current) throw new Error(`No job record for ${id}`);
  const next = { ...current, ...patch };
  writeJob(next);
  return next;
}

export function listJobs(): JobRecord[] {
  const dir = jobsDir();
  if (!fs.existsSync(dir)) return [];
  const records = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as JobRecord;
      } catch {
        return undefined;
      }
    })
    .filter((r): r is JobRecord => r !== undefined);
  return records.sort(
    (a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.submittedAt.localeCompare(a.submittedAt)
  );
}

export type PollState =
  | { status: 'processing' }
  | { status: 'completed'; urls: string[] }
  | { status: 'failed'; code?: number | string; message: string };

/** Thrown by a poller when the poll may simply be repeated (429, transient 5xx). */
export class RetryableError extends Error {}

export interface WaitOptions {
  waitSeconds: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (status: string) => void;
}

/**
 * Poll until a terminal state or the deadline. Only polls are repeated; this
 * function never submits anything. Retryable errors and network TypeErrors
 * double the delay (capped at 30 s); any other error propagates.
 */
export async function waitForJob(poll: () => Promise<PollState>, o: WaitOptions): Promise<PollState | { status: 'timeout' }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const start = now();
  const deadline = start + o.waitSeconds * 1000;
  let delay = o.intervalMs;

  for (;;) {
    try {
      const state = await poll();
      if (state.status !== 'processing') return state;
      delay = o.intervalMs;
      o.onProgress?.(`Still running (${Math.round((now() - start) / 1000)}s elapsed)...`);
    } catch (err) {
      if (!(err instanceof RetryableError) && !(err instanceof TypeError)) throw err;
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      o.onProgress?.(`Polling paused (${(err as Error).message}); retrying in ${Math.round(delay / 1000)}s...`);
    }
    if (now() + delay > deadline) return { status: 'timeout' };
    await sleep(delay);
  }
}
