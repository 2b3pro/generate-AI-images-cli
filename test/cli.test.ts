import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
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
  env = { ...(process.env as Record<string, string>), GENERATE_MODELS_DIR: path.join(root, 'models'), GENERATE_JOBS_DIR: jobs, ATLASCLOUD_API_KEY: 'test-key', ELEVENLABS_API_KEY: 'test-key' };
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

  test('--voice reaches the provider (a malformed dialogue pair is rejected before any network call)', () => {
    const r = cli(['-m', 'el-dialogue', 'A: hi', '--voice', 'A', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatch(/look like Speaker=<name\|id>/);
  });

  test('--json output larger than a pipe buffer arrives complete', () => {
    for (let i = 0; i < 300; i++) {
      writeJob({ id: `big-${i}`, provider: 'atlas', model: 'img-shared', kind: 'image', output: `/tmp/${'x'.repeat(200)}-${i}.png`, submittedAt: '2026-10-04T00:00:00Z', status: 'completed', outputs: [`/tmp/${'y'.repeat(200)}-${i}.png`] });
    }
    // Through a real shell pipe: the reader drains slowly, which is where process.exit() truncated output.
    const piped = Bun.spawnSync(['sh', '-c', `bun "${CLI}" --jobs --json | (sleep 0.2; cat)`], { env, stdout: 'pipe', stderr: 'pipe' });
    const out = piped.stdout.toString();
    expect(out.length).toBeGreaterThan(65536);
    expect(JSON.parse(out)).toHaveLength(300);
  });
});


describe.skipIf(!Bun.which('ffmpeg'))('cli frames', () => {
  let dir: string;
  let clip: string;

  beforeAll(() => {
    dir = tmpDir('gen-cli-frames-');
    clip = path.join(dir, 'clip.mp4');
    const r = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=24:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip], { stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  });

  test('--frame writes one still and exits without a prompt or model', () => {
    const out = path.join(dir, 'still.png');
    const r = cli(['--frame', `${clip}@last`, '-o', out, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, outputs: [out], model: null });
    expect(existsSync(out)).toBe(true);
  });

  test('--frame without a time selector exits 2', () => {
    const r = cli(['--frame', clip, '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/--frame expects <video>@<time>/);
  });

  test('--sheet --strip --every lays the samples out in one row next to the clip', async () => {
    const r = cli(['--sheet', clip, '--strip', '--every', '0.5', '--json']);
    expect(r.code).toBe(0);
    const out = path.join(dir, 'clip_strip.png');
    expect(JSON.parse(r.stdout).outputs).toEqual([out]);
    expect(await sharp(out).metadata()).toMatchObject({ width: 4 * 320 + 3 * 4, height: 180 });
  });

  test('without ffmpeg on PATH, --frame fails with a message naming it', () => {
    const r = Bun.spawnSync([process.execPath, CLI, '--frame', `${clip}@first`, '--json'], { env: { ...env, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout.toString()).error).toMatch(/ffmpeg not found on PATH/);
  });

  test('--ref start=<video>@last extracts the frame before refs are checked, and reports it', () => {
    const out = path.join(dir, 'next.mp4');
    const r = cli(['-m', 'vid-shared', 'walk', '-o', out, '--ref', `start=${clip}@last`, '--ref', 'identity=b.png', '--json']);
    expect(r.code).toBe(2);
    const json = JSON.parse(r.stdout);
    expect(json.error).toMatch(/cannot combine start and identity/);
    expect(json.frames).toEqual([path.join(dir, 'next_ref1-start.png')]);
    expect(existsSync(json.frames[0])).toBe(true);
  });

  test('after a generation, thumbnails land under frames and --filmstrip on an image job is a warning', () => {
    const out = path.join(dir, 'img.png');
    const stubEnv = { ...env, GENERATE_CODEX_BIN: path.resolve(import.meta.dir, 'fixtures/stub-agent.sh'), STUB_MODE: 'codex' };
    const r = Bun.spawnSync(['bun', CLI, '-m', 'img-shared', '--via', 'codex', 'a dot', '-o', out, '--thumbnail', '--filmstrip', '--json'], { env: stubEnv, stdout: 'pipe', stderr: 'pipe' });
    const json = JSON.parse(r.stdout.toString());
    expect(r.exitCode).toBe(0);
    expect(json.outputs).toEqual([out]);
    expect(json.frames).toEqual([path.join(dir, 'img_thumb.png')]);
    expect(json.warnings).toContain('--filmstrip applies to video outputs; ignored');
  });

  test('a video ref past the end of the clip exits 2 and sends nothing', () => {
    const r = cli(['-m', 'vid-shared', 'walk', '-o', path.join(dir, 'x.mp4'), '--ref', `start=${clip}@99`, '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/past the end/);
  });
});
