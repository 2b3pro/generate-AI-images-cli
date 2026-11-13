import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { getModelSpec } from '../src/config/models';
import { AtlasClient } from '../src/providers/atlas-client';
import { AtlasProvider, buildAtlasRequest } from '../src/providers/atlas';
import { readJob } from '../src/utils/jobs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});
afterAll(useRealRegistry);

describe('buildAtlasRequest', () => {
  test('text-to-image uses the base id and mapped fields', () => {
    const spec = getModelSpec('img-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'img-shared', prompt: 'cat', aspectRatio: '1:1', size: '2K', seed: 7 }, { legacy: [], refs: [] });
    expect(r.modelId).toBe('vendor/img/text-to-image');
    expect(r.body).toEqual({ model: 'vendor/img/text-to-image', prompt: 'cat', aspect_ratio: '1:1', resolution: '2k', seed: 7 });
  });

  test('legacy -r on an image model switches to the edit id and fills images', () => {
    const spec = getModelSpec('img-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'img-shared', prompt: 'fix' }, { legacy: ['https://u/1', 'https://u/2'], refs: [] });
    expect(r.modelId).toBe('vendor/img/edit');
    expect(r.body.images).toEqual(['https://u/1', 'https://u/2']);
  });

  test('role refs on an image model are labelled in the prompt in send order', () => {
    const spec = getModelSpec('img-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'img-shared', prompt: 'portrait' }, { legacy: [], refs: [{ role: 'identity', source: 'a', url: 'https://u/a', note: 'face only' }] });
    expect(r.body.images).toEqual(['https://u/a']);
    expect(r.promptSent).toBe('portrait\n\n@Image1: identity reference: keep this person or character recognisably the same (face only).');
  });

  test('video start/end frames use i2v and frame fields', () => {
    const spec = getModelSpec('vid-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'vid-shared', prompt: 'walk', duration: 5 }, {
      legacy: [],
      refs: [{ role: 'start', source: 's', url: 'https://u/s' }, { role: 'end', source: 'e', url: 'https://u/e' }],
    });
    expect(r.modelId).toBe('vendor/vid/image-to-video');
    expect(r.body).toMatchObject({ image: 'https://u/s', end_image: 'https://u/e', duration: 5 });
  });

  test('video identity refs use r2v and reference_images', () => {
    const spec = getModelSpec('vid-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'vid-shared', prompt: 'talk' }, { legacy: [], refs: [{ role: 'identity', source: 'a', url: 'https://u/a' }] });
    expect(r.modelId).toBe('vendor/vid/reference-to-video');
    expect(r.body.reference_images).toEqual(['https://u/a']);
  });

  test('negative prompt: native field when mapped, folded otherwise; params override last', () => {
    const vid = buildAtlasRequest(getModelSpec('vid-shared', 'atlas'), { model: 'vid-shared', prompt: 'p', negativePrompt: 'blur', params: { sound: true, duration: 9 }, duration: 5 }, { legacy: [], refs: [] });
    expect(vid.body).toMatchObject({ negative_prompt: 'blur', sound: true, duration: 9 });
    const img = buildAtlasRequest(getModelSpec('img-shared', 'atlas'), { model: 'img-shared', prompt: 'p', negativePrompt: 'blur' }, { legacy: [], refs: [] });
    expect(img.promptSent).toBe('p\n\nAvoid: blur');
  });

  test('audio uses the mapped prompt field', () => {
    const r = buildAtlasRequest(getModelSpec('tts-only', 'atlas'), { model: 'tts-only', prompt: 'hello' }, { legacy: [], refs: [] });
    expect(r.body).toEqual({ model: 'vendor/tts', text: 'hello' });
  });
});

function scripted(responses: Response[]) {
  const posts: string[] = [];
  let pollHook: (() => void) | undefined;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push(u);
    if (u.includes('/model/prediction/')) pollHook?.();
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${u}`);
    return next;
  }) as typeof fetch;
  return { impl, posts, onFirstPoll: (fn: () => void) => { pollHook = fn; } };
}

describe('AtlasProvider jobs', () => {
  test('submits once, records the job before polling, downloads with the served extension', async () => {
    const s = scripted([
      json({ data: { id: 'pred-1' } }),
      json({ data: { status: 'processing', outputs: [] } }),
      json({ data: { status: 'completed', outputs: ['https://cdn/x/result'] } }),
      new Response('JPEGBYTES', { headers: { 'content-type': 'image/jpeg' } }),
    ]);
    let recordAtFirstPoll: string | undefined;
    s.onFirstPoll(() => { recordAtFirstPoll ??= readJob('pred-1')?.status; });
    const out = path.join(tmpDir(), 'out.png');
    const result = await new AtlasProvider(new AtlasClient('k', s.impl)).generate({ model: 'img-shared', prompt: 'cat', output: out, waitSeconds: 30 });
    expect(recordAtFirstPoll).toBe('pending');
    expect(result.success).toBe(true);
    expect(result.outputs).toEqual([out.replace(/\.png$/, '.jpg')]);
    expect(fs.readFileSync(result.outputs![0], 'utf8')).toBe('JPEGBYTES');
    expect(readJob('pred-1')?.status).toBe('completed');
    expect(s.posts.filter((u) => u.includes('/generate'))).toHaveLength(1);
  });

  test('timeout leaves a pending record and returns pending', async () => {
    const s = scripted([json({ data: { id: 'pred-2' } }), json({ data: { status: 'processing' } })]);
    const result = await new AtlasProvider(new AtlasClient('k', s.impl)).generate({ model: 'img-shared', prompt: 'cat', output: path.join(tmpDir(), 'o.png'), waitSeconds: 0 });
    expect(result.pending).toBe(true);
    expect(result.jobId).toBe('pred-2');
    expect(readJob('pred-2')?.status).toBe('pending');
  });

  test('moderation failure is recorded with a plain message', async () => {
    const s = scripted([json({ data: { id: 'pred-3' } }), json({ data: { status: 'failed', error: 'x', error_code: 1039 } })]);
    const result = await new AtlasProvider(new AtlasClient('k', s.impl)).generate({ model: 'img-shared', prompt: 'cat', output: path.join(tmpDir(), 'o.png'), waitSeconds: 30 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('rejected by content moderation (Atlas error 1039)');
    expect(readJob('pred-3')?.status).toBe('failed');
  });

  test('quote uploads local refs once and calls /calculate, not /generate', async () => {
    const ref = path.join(tmpDir(), 'face.png');
    fs.writeFileSync(ref, 'png');
    const s = scripted([json({ url: 'https://t/face' }), json({ data: { price: 0.05 } })]);
    const quoted = await new AtlasProvider(new AtlasClient('k', s.impl)).quote({ model: 'img-shared', prompt: 'p', refs: [{ role: 'identity', source: ref }] });
    expect(quoted).toEqual({ usd: 0.05, providerModelId: 'vendor/img/edit' });
    expect(s.posts.some((u) => u.includes('/generate'))).toBe(false);
  });
});

describe('review fixes', () => {
  test('a failure after submit keeps the job id and says how to resume', async () => {
    const s = scripted([
      json({ data: { id: 'pred-9' } }),
      json({ data: { status: 'completed', outputs: ['https://cdn/x/r.png'] } }),
      new Response('denied', { status: 403 }),
    ]);
    const result = await new AtlasProvider(new AtlasClient('k', s.impl)).generate({ model: 'img-shared', prompt: 'cat', output: path.join(tmpDir(), 'o.png'), waitSeconds: 30 });
    expect(result.success).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.jobId).toBe('pred-9');
    expect(result.error).toMatch(/generate --resume pred-9/);
    expect(s.posts.filter((u) => u.includes('/generate'))).toHaveLength(1);
  });

  test('legacy -r beyond the model cap is rejected before submit, not silently dropped', async () => {
    const dir = tmpDir();
    const files = ['a', 'b', 'c', 'd'].map((n) => { const f = path.join(dir, `${n}.png`); fs.writeFileSync(f, 'x'); return f; });
    const s = scripted([json({ url: 'https://t/a' }), json({ url: 'https://t/b' }), json({ url: 'https://t/c' }), json({ url: 'https://t/d' })]);
    const result = await new AtlasProvider(new AtlasClient('k', s.impl)).generate({ model: 'img-shared', prompt: 'x', referenceImages: files, output: path.join(dir, 'o.png') });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at most 3 reference images; got 4/);
    expect(s.posts.some((u) => u.includes('/generate'))).toBe(false);
  });

  test('video takes one legacy -r frame and not alongside --ref start', () => {
    const spec = getModelSpec('vid-shared', 'atlas');
    expect(() => buildAtlasRequest(spec, { model: 'vid-shared', prompt: 'p' }, { legacy: ['https://u/1', 'https://u/2'], refs: [] })).toThrow(/one start frame/);
    expect(() => buildAtlasRequest(spec, { model: 'vid-shared', prompt: 'p' }, { legacy: ['https://u/1'], refs: [{ role: 'start', source: 's', url: 'https://u/s' }] })).toThrow(/both -r and --ref start/);
  });
});

describe('Atlas default_params (real config)', () => {
  test('veo-3.1 sends generate_audio=false unless --param overrides it', () => {
    useRealRegistry();
    const spec = getModelSpec('veo-3.1', 'atlas');
    expect(buildAtlasRequest(spec, { model: 'veo-3.1', prompt: 'p' }, { legacy: [], refs: [] }).body.generate_audio).toBe(false);
    expect(buildAtlasRequest(spec, { model: 'veo-3.1', prompt: 'p', params: { generate_audio: true } }, { legacy: [], refs: [] }).body.generate_audio).toBe(true);
  });

  test('kling-3-pro sends sound=false and no resolution or negative_prompt field', () => {
    useRealRegistry();
    const spec = getModelSpec('kling-3-pro', 'atlas');
    const { body } = buildAtlasRequest(spec, { model: 'kling-3-pro', prompt: 'p', negativePrompt: 'blur', resolution: '1080p' }, { legacy: [], refs: [] });
    expect(body.sound).toBe(false);
    expect(body).not.toHaveProperty('resolution');
    expect(body).not.toHaveProperty('negative_prompt');
  });
});

describe('new Atlas models (real config)', () => {
  test('wan-3 sends -a as ratio on text-to-video and leaves it off image-to-video', () => {
    useRealRegistry();
    const spec = getModelSpec('wan-3', 'atlas');
    const t2v = buildAtlasRequest(spec, { model: 'wan-3', prompt: 'p', aspectRatio: '16:9' }, { legacy: [], refs: [] });
    expect(t2v.modelId).toBe('alibaba/wan-3.0/text-to-video');
    expect(t2v.body.ratio).toBe('16:9');
    const i2v = buildAtlasRequest(spec, { model: 'wan-3', prompt: 'p', aspectRatio: '16:9' }, { legacy: ['https://u/f.png'], refs: [] });
    expect(i2v.modelId).toBe('alibaba/wan-3.0/image-to-video');
    expect(i2v.body).not.toHaveProperty('ratio');
    expect(i2v.body.image).toBe('https://u/f.png');
  });

  test('kling-4 maps 4k to the upscaled tier and sends aspect_ratio on text-to-video only', () => {
    useRealRegistry();
    const spec = getModelSpec('kling-4', 'atlas');
    const t2v = buildAtlasRequest(spec, { model: 'kling-4', prompt: 'p', aspectRatio: '21:9', resolution: '4k', duration: 20 }, { legacy: [], refs: [] });
    expect(t2v.body).toMatchObject({ aspect_ratio: '21:9', resolution: '4k-esr', duration: 20 });
    const i2v = buildAtlasRequest(spec, { model: 'kling-4', prompt: 'p', aspectRatio: '21:9' }, { legacy: [], refs: [{ role: 'start', source: 's', url: 'https://u/s.png' }, { role: 'end', source: 'e', url: 'https://u/e.png' }] });
    expect(i2v.body).toMatchObject({ image: 'https://u/s.png', last_image: 'https://u/e.png' });
    expect(i2v.body).not.toHaveProperty('aspect_ratio');
  });

  test('seedream-5.5 edits send reference_images to the edit variant', () => {
    useRealRegistry();
    const spec = getModelSpec('seedream-5.5', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'seedream-5.5', prompt: 'p', size: '1K' }, { legacy: ['https://u/1.png'], refs: [] });
    expect(r.modelId).toBe('bytedance/seedream-v5.5/edit');
    expect(r.body).toMatchObject({ reference_images: ['https://u/1.png'], size: '1024*1024' });
  });
});

describe('Gemini Omni via Atlas (real config)', () => {
  test('references go to reference-to-video as reference_images, described in prose (1.2 deprecates <IMAGE_REF_N> tags)', () => {
    useRealRegistry();
    const spec = getModelSpec('gemini-omni', 'atlas');
    const { modelId, body } = buildAtlasRequest(spec, { model: 'gemini-omni', prompt: 'two friends toast', duration: 6, resolution: '1080p' }, {
      legacy: [],
      refs: [{ role: 'identity', source: 'a', url: 'https://x/a.png' }, { role: 'identity', source: 'b', url: 'https://x/b.png' }],
    });
    expect(modelId).toBe('google/gemini-omni-1.2-flash/reference-to-video');
    expect(body.reference_images).toEqual(['https://x/a.png', 'https://x/b.png']);
    expect(body.prompt).toContain('the second image is the identity reference');
    expect(body.prompt).not.toContain('<IMAGE_REF');
    expect(body).toMatchObject({ duration: 6, resolution: '1080p' });
  });

  test('start and end frames use image-to-video with image and last_image', () => {
    useRealRegistry();
    const spec = getModelSpec('gemini-omni', 'atlas');
    const { modelId, body } = buildAtlasRequest(spec, { model: 'gemini-omni', prompt: 'p' }, {
      legacy: [],
      refs: [{ role: 'start', source: 's', url: 'https://x/s.png' }, { role: 'end', source: 'e', url: 'https://x/e.png' }],
    });
    expect(modelId).toBe('google/gemini-omni-1.2-flash/image-to-video');
    expect(body).toMatchObject({ image: 'https://x/s.png', last_image: 'https://x/e.png' });
  });
});
