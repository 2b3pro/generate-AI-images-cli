import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { GenerateOptions, GenerationResult, ImageProvider, JobRecord, Provider } from '../src/types';
import { draftPath, resumeJob, run, type RunDeps, type RunRequest } from '../src/run';
import { writeJob } from '../src/utils/jobs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

class FakeProvider implements ImageProvider {
  name = 'fake';
  models = [];
  calls: { generate: GenerateOptions[]; quote: number; resume: number } = { generate: [], quote: 0, resume: 0 };
  quote?: (o: GenerateOptions) => Promise<number>;
  constructor(private result: GenerationResult = { success: true, outputPath: '/tmp/x.png' }, private price?: number) {}
  async generate(o: GenerateOptions) { this.calls.generate.push(o); return this.result; }
  async resume() { this.calls.resume++; return this.result; }
  withQuote() { this.quote = async () => { this.calls.quote++; return this.price!; }; return this; }
}

function deps(map: Partial<Record<Provider, FakeProvider>>): RunDeps {
  return { getProvider: (p) => { const f = map[p]; if (!f) throw new Error(`no fake for ${p}`); return f; } };
}

const req = (over: Partial<RunRequest> = {}, opts: Partial<GenerateOptions> = {}): RunRequest => ({
  modelInput: 'img-shared',
  billing: 'any',
  draft: false,
  quoteOnly: false,
  ...over,
  options: { prompt: 'p', output: '/tmp/o.png', ...opts },
});

beforeEach(() => {
  writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});
afterAll(useRealRegistry);

describe('run', () => {
  test('routes to the active provider and reports billing', async () => {
    const google = new FakeProvider();
    const json = await run(req(), deps({ google }));
    expect(json).toMatchObject({ ok: true, exit_code: 0, provider: 'google', billing: 'metered', outputs: ['/tmp/x.png'] });
  });

  test('--billing plan routes to the plan offer', async () => {
    const codex = new FakeProvider();
    const json = await run(req({ billing: 'plan' }), deps({ codex }));
    expect(json).toMatchObject({ ok: true, provider: 'codex', billing: 'plan', agentic: true });
  });

  test('--billing plan with no plan path is rejected before anything is sent', async () => {
    const json = await run(req({ modelInput: 'vid-shared', billing: 'plan' }), deps({}));
    expect(json.exit_code).toBe(2);
    expect(json.error).toMatch(/no plan-billed path for vid-shared/);
  });

  test('reference validation failure exits 2 and never calls the provider', async () => {
    const atlas = new FakeProvider();
    const json = await run(req({ modelInput: 'vid-shared' }, { refs: [{ role: 'start', source: 'a' }, { role: 'identity', source: 'b' }] }), deps({ atlas }));
    expect(json.exit_code).toBe(2);
    expect(json.error).toMatch(/cannot combine start and identity/);
    expect(atlas.calls.generate).toHaveLength(0);
  });

  test('forced duration reaches the provider and is announced', async () => {
    const atlas = new FakeProvider();
    const json = await run(req({ modelInput: 'vid-shared' }, { duration: 5, refs: [{ role: 'identity', source: 'a' }] }), deps({ atlas }));
    expect(atlas.calls.generate[0].duration).toBe(8);
    expect(json.warnings.some((w) => w.includes('overridden to 8s'))).toBe(true);
  });

  test('--draft swaps to the draft model tier and suffixes the output', async () => {
    const google = new FakeProvider();
    await run(req({ modelInput: 'vid-shared', via: 'google', draft: true }, { output: '/tmp/clip.mp4' }), deps({ google }));
    expect(google.calls.generate[0]).toMatchObject({ model: 'vid-lite', output: '/tmp/clip.draft.mp4', draft: true });
  });

  test('--draft on a resolution tier keeps the model and lowers resolution', async () => {
    const atlas = new FakeProvider();
    await run(req({ modelInput: 'vid-shared', draft: true }, { resolution: '1080p' }), deps({ atlas }));
    expect(atlas.calls.generate[0]).toMatchObject({ model: 'vid-shared', resolution: '480p' });
  });

  test('--draft on a model without a tier is rejected', async () => {
    const json = await run(req({ draft: true }), deps({ google: new FakeProvider() }));
    expect(json.exit_code).toBe(2);
    expect(json.error).toMatch(/has no draft tier/);
  });

  test('--quote uses the provider quote and never generates', async () => {
    const atlas = new FakeProvider(undefined, 0.07).withQuote();
    const json = await run(req({ via: 'atlas', quoteOnly: true }), deps({ atlas }));
    expect(json).toMatchObject({ ok: true, exit_code: 0, quote_usd: 0.07 });
    expect(atlas.calls.generate).toHaveLength(0);
  });

  test('--quote falls back to list price; per-second prices scale by duration', async () => {
    const json = await run(req({ modelInput: 'vid-shared', via: 'google', quoteOnly: true }, { duration: 6 }), deps({ google: new FakeProvider() }));
    expect(json.quote_usd).toBeCloseTo(2.4);
  });

  test('--max-cost refuses above the limit and when no price exists', async () => {
    const atlas = new FakeProvider(undefined, 0.5).withQuote();
    const over = await run(req({ via: 'atlas', maxCost: 0.1 }), deps({ atlas }));
    expect(over.exit_code).toBe(2);
    expect(atlas.calls.generate).toHaveLength(0);
    const unpriced = await run(req({ modelInput: 'agy-image', maxCost: 1 }), deps({ agy: new FakeProvider() }));
    expect(unpriced.exit_code).toBe(2);
    expect(unpriced.error).toMatch(/no price is available/);
  });

  test('pending maps to 75, or 0 with --no-wait', async () => {
    const pending = new FakeProvider({ success: false, pending: true, jobId: 'j1' });
    expect((await run(req(), deps({ google: pending }))).exit_code).toBe(75);
    const json = await run(req({}, { noWait: true }), deps({ google: pending }));
    expect(json).toMatchObject({ ok: true, exit_code: 0, pending: true, job_id: 'j1' });
  });

  test('provider failure maps to 1', async () => {
    const json = await run(req(), deps({ google: new FakeProvider({ success: false, error: 'quota' }) }));
    expect(json).toMatchObject({ ok: false, exit_code: 1, error: 'quota' });
  });
});

describe('resumeJob', () => {
  const record = (status: JobRecord['status']): JobRecord => ({ id: 'r1', provider: 'atlas', model: 'img-shared', kind: 'image', output: '/tmp/o.png', submittedAt: '2026-10-04T00:00:00Z', status, outputs: status === 'completed' ? ['/tmp/o.jpg'] : undefined });

  test('resume of a completed job returns recorded outputs without any provider call', async () => {
    writeJob(record('completed'));
    const json = await resumeJob('r1', {}, deps({}));
    expect(json).toMatchObject({ ok: true, exit_code: 0, outputs: ['/tmp/o.jpg'] });
  });

  test('pending job resumes through the provider', async () => {
    writeJob(record('pending'));
    const atlas = new FakeProvider({ success: true, outputs: ['/tmp/o.png'] });
    const json = await resumeJob('r1', {}, deps({ atlas }));
    expect(atlas.calls.resume).toBe(1);
    expect(json.exit_code).toBe(0);
  });

  test('unknown id is a clear error', async () => {
    expect((await resumeJob('nope', {}, deps({}))).error).toMatch(/No job record for nope/);
  });
});

test('draftPath', () => {
  expect(draftPath('/a/b.mp4')).toBe('/a/b.draft.mp4');
  expect(draftPath('/a/b')).toBe('/a/b.draft');
});
