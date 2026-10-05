import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'path';
import { writeJob } from '../src/utils/jobs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');
let env: Record<string, string>;

function cli(args: string[]) {
  const r = Bun.spawnSync(['bun', CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

beforeEach(() => {
  const root = writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
  const jobs = tmpDir('gen-jobs-');
  process.env.GENERATE_JOBS_DIR = jobs;
  env = { ...(process.env as Record<string, string>), GENERATE_MODELS_DIR: path.join(root, 'models'), GENERATE_JOBS_DIR: jobs, ATLASCLOUD_API_KEY: 'test-key' };
});
afterAll(useRealRegistry);

describe('cli', () => {
  test('--jobs --json lists records', () => {
    writeJob({ id: 'j1', provider: 'atlas', model: 'img-shared', kind: 'image', output: '/tmp/o.png', submittedAt: '2026-10-04T00:00:00Z', status: 'pending' });
    const r = cli(['--jobs', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)[0].id).toBe('j1');
  });

  test('invalid reference combination exits 2 with a JSON error and sends nothing', () => {
    const r = cli(['-m', 'vid-shared', 'walk', '--ref', 'start=a.png', '--ref', 'identity=b.png', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/cannot combine start and identity/);
  });

  test('--billing plan on a video model exits 2', () => {
    const r = cli(['-m', 'vid-shared', 'walk', '--billing', 'plan', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/no plan-billed path/);
  });

  test('bad --ref syntax exits 2', () => {
    const r = cli(['-m', 'img-shared', 'x', '--ref', 'face=a.png', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/Unknown reference role/);
  });

  test('--resume of an unknown id exits 1', () => {
    const r = cli(['--resume', 'nope', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatch(/No job record for nope/);
  });

  test('--resume of a completed job prints its outputs', () => {
    writeJob({ id: 'done1', provider: 'atlas', model: 'img-shared', kind: 'image', output: '/tmp/o.png', submittedAt: '2026-10-04T00:00:00Z', status: 'completed', outputs: ['/tmp/o.jpg'] });
    const r = cli(['--resume', 'done1', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).outputs).toEqual(['/tmp/o.jpg']);
  });

  test('--json keeps stdout to exactly one JSON document', () => {
    const r = cli(['-m', 'vid-shared', 'walk', '--billing', 'plan', '--json']);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });
});
