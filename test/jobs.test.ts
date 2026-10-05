import { beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import type { JobRecord } from '../src/types';
import { listJobs, readJob, RetryableError, updateJob, waitForJob, writeJob, type PollState } from '../src/utils/jobs';
import { tmpDir } from './helpers/registry';

function rec(id: string, status: JobRecord['status'], submittedAt: string): JobRecord {
  return { id, provider: 'atlas', model: 'm', kind: 'image', output: '/tmp/o.png', submittedAt, status };
}

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

beforeEach(() => {
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});

describe('records', () => {
  test('write, read, update', () => {
    writeJob(rec('abc', 'pending', '2026-10-04T10:00:00Z'));
    expect(readJob('abc')?.status).toBe('pending');
    updateJob('abc', { status: 'completed', outputs: ['/tmp/o.png'] });
    expect(readJob('abc')?.outputs).toEqual(['/tmp/o.png']);
    expect(readJob('missing')).toBeUndefined();
  });

  test('ids with slashes are stored safely', () => {
    writeJob(rec('models/veo/operations/xyz', 'pending', '2026-10-04T10:00:00Z'));
    expect(readJob('models/veo/operations/xyz')?.id).toBe('models/veo/operations/xyz');
  });

  test('lists pending first, then newest', () => {
    writeJob(rec('old-done', 'completed', '2026-10-01T00:00:00Z'));
    writeJob(rec('new-done', 'completed', '2026-10-03T00:00:00Z'));
    writeJob(rec('pending', 'pending', '2026-09-01T00:00:00Z'));
    expect(listJobs().map((j) => j.id)).toEqual(['pending', 'new-done', 'old-done']);
  });

  test('writes atomically (no temp files left, valid JSON)', () => {
    for (let i = 0; i < 20; i++) writeJob(rec('race', 'pending', `2026-10-04T10:00:${String(i).padStart(2, '0')}Z`));
    const files = fs.readdirSync(process.env.GENERATE_JOBS_DIR!);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readJob('race')?.submittedAt).toBe('2026-10-04T10:00:19Z');
  });
});

describe('waitForJob', () => {
  test('returns the terminal state after processing polls', async () => {
    const clock = fakeClock();
    const states: PollState[] = [{ status: 'processing' }, { status: 'processing' }, { status: 'completed', urls: ['u'] }];
    const result = await waitForJob(async () => states.shift()!, { waitSeconds: 60, intervalMs: 2000, ...clock });
    expect(result).toEqual({ status: 'completed', urls: ['u'] });
    expect(clock.sleeps).toEqual([2000, 2000]);
  });

  test('backs off on retryable errors, capped, then resets', async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await waitForJob(
      async () => {
        n++;
        if (n <= 2) throw new RetryableError('429');
        if (n === 3) return { status: 'processing' };
        return { status: 'failed', code: 1039, message: 'x' };
      },
      { waitSeconds: 600, intervalMs: 2000, ...clock }
    );
    expect(result.status).toBe('failed');
    expect(clock.sleeps).toEqual([4000, 8000, 2000]);
  });

  test('network TypeErrors are retryable', async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await waitForJob(
      async () => {
        if (n++ === 0) throw new TypeError('fetch failed');
        return { status: 'completed', urls: [] };
      },
      { waitSeconds: 60, intervalMs: 2000, ...clock }
    );
    expect(result.status).toBe('completed');
  });

  test('times out without sleeping past the deadline', async () => {
    const clock = fakeClock();
    const result = await waitForJob(async () => ({ status: 'processing' }), { waitSeconds: 5, intervalMs: 2000, ...clock });
    expect(result).toEqual({ status: 'timeout' });
    expect(clock.now()).toBeLessThanOrEqual(5000);
  });

  test('non-retryable errors propagate', async () => {
    const clock = fakeClock();
    await expect(waitForJob(async () => { throw new Error('401 unauthorized'); }, { waitSeconds: 60, intervalMs: 2000, ...clock })).rejects.toThrow('401');
  });
});
