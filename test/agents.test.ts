import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { AgyProvider } from '../src/providers/agy';
import { CodexProvider } from '../src/providers/codex';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

const STUB = path.resolve(import.meta.dir, 'fixtures/stub-agent.sh');
let argsFile: string;

beforeEach(() => {
  writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
  argsFile = path.join(tmpDir(), 'args.txt');
  process.env.STUB_ARGS_FILE = argsFile;
  process.env.GENERATE_CODEX_BIN = STUB;
  process.env.GENERATE_AGY_BIN = STUB;
  for (const k of ['STUB_EXIT', 'STUB_NO_FILE', 'STUB_SLEEP']) delete process.env[k];
});
afterAll(useRealRegistry);

const mime = (p: string) => Bun.spawnSync(['file', '--mime-type', '-b', p]).stdout.toString().trim();
const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.startsWith('.generate-agent-'));

describe('codex', () => {
  beforeEach(() => { process.env.STUB_MODE = 'codex'; });

  test('generates through a staged file and cleans up', async () => {
    const dir = tmpDir();
    const out = path.join(dir, 'o.png');
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'a lighthouse', output: out });
    expect(result.success).toBe(true);
    expect(mime(out)).toBe('image/png');
    expect(leftovers(dir)).toEqual([]);
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).toContain('exec');
    expect(args).toContain('workspace-write');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).not.toContain('--model');
  });

  test('converts to JPEG when asked', async () => {
    const out = path.join(tmpDir(), 'o.jpg');
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'x', output: out });
    expect(result.success).toBe(true);
    expect(mime(out)).toBe('image/jpeg');
  });

  test('resolves reference paths (spaces, relative) to absolute real paths', async () => {
    const dir = tmpDir();
    const primary = path.join(dir, 'old photo.png');
    const ref = path.join(dir, 'face ref.png');
    fs.writeFileSync(primary, 'x');
    fs.writeFileSync(ref, 'x');
    const rel = path.relative(process.cwd(), ref);
    await new CodexProvider().generate({ model: 'img-shared', prompt: 'restore', output: path.join(dir, 'o.png'), referenceImages: [primary], refs: [{ role: 'identity', source: rel, note: 'face of the man' }] });
    const prompt = fs.readFileSync(`${argsFile}.prompt`, 'utf8');
    expect(prompt).toContain(`Primary image file (edit target): ${primary}`);
    expect(prompt).toContain(`Reference image 1 (identity reference: face of the man; never composite it): ${ref}`);
  });

  test('missing staged file is an error, not a success', async () => {
    process.env.STUB_NO_FILE = '1';
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'x', output: path.join(tmpDir(), 'o.png') });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/without creating the image/);
  });

  test('nonzero exit is an error', async () => {
    process.env.STUB_EXIT = '3';
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'x', output: path.join(tmpDir(), 'o.png') });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exited with code 3/);
  });

  test('timeout kills the agent and says plan usage may be spent', async () => {
    process.env.STUB_SLEEP = '5';
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'x', output: path.join(tmpDir(), 'o.png'), waitSeconds: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out after 1s; the run may still have used plan usage/);
  });
});

describe('agy', () => {
  beforeEach(() => { process.env.STUB_MODE = 'agy'; });

  test('runs sandboxed in the stage directory and saves a relative file', async () => {
    const dir = tmpDir();
    const out = path.join(dir, 'o.png');
    const result = await new AgyProvider().generate({ model: 'agy-image', prompt: 'a lighthouse', output: out });
    expect(result.success).toBe(true);
    expect(mime(out)).toBe('image/png');
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).toContain('--sandbox');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toMatch(new RegExp(`cwd=${dir}/\\.generate-agent-`));
    expect(result.providerModelId).toBe('agy default agent model');
    expect(leftovers(dir)).toEqual([]);
  });
});
