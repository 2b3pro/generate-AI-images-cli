import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { GoogleProvider, omniPollState, omniVideo, type Interaction, type InteractionsApi } from '../src/providers/google';
import { readJob, writeJob } from '../src/utils/jobs';
import { tmpDir, useRealRegistry } from './helpers/registry';

/** Response shape recorded from a live gemini-omni-1.1-flash interaction on 2026-10-08. */
const done = (data: string): Interaction => ({
  id: 'v1_abc',
  status: 'completed',
  steps: [
    { type: 'user_input', content: [{ type: 'text' } as never] },
    { type: 'thought' },
    { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data }] },
  ],
});

function fakeApi(sequence: Interaction[]) {
  const calls = { create: [] as Record<string, unknown>[], get: 0 };
  const api: InteractionsApi = {
    create: async (body) => {
      calls.create.push(body);
      return { id: 'v1_abc', status: 'in_progress' };
    },
    get: async () => {
      calls.get++;
      return sequence.length > 1 ? sequence.shift()! : sequence[0];
    },
    download: async () => {
      throw new Error('not used: bytes are inline');
    },
  };
  return { api, calls };
}

const provider = (api: InteractionsApi) => new GoogleProvider(undefined, api);
const mp4 = Buffer.from('fake-mp4').toString('base64');

beforeEach(() => {
  useRealRegistry();
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});
afterAll(useRealRegistry);

describe('omniPollState', () => {
  test('maps interaction states', () => {
    expect(omniPollState({ status: 'in_progress' })).toEqual({ status: 'processing' });
    expect(omniPollState({ status: 'completed' })).toEqual({ status: 'completed', urls: [] });
    expect(omniPollState({ status: 'failed', error: { message: 'blocked' } })).toEqual({ status: 'failed', message: 'interaction failed: {"message":"blocked"}' });
    expect(omniPollState({ status: 'cancelled' })).toMatchObject({ status: 'failed' });
  });

  test('finds the video in the model output, not the echoed input', () => {
    expect(omniVideo(done(mp4))?.data).toBe(mp4);
    expect(omniVideo({ steps: [{ type: 'user_input', content: [{ type: 'video', data: 'input-clip' }] }] })).toBeUndefined();
  });
});

describe('Omni jobs', () => {
  test('submits a background interaction with an explicit duration and saves the inline clip', async () => {
    const { api, calls } = fakeApi([done(mp4)]);
    const out = path.join(tmpDir(), 'o.png');
    const result = await provider(api).generate({ model: 'gemini-omni', prompt: 'a paper boat', output: out, aspectRatio: '4:3', negativePrompt: 'text' });
    expect(result.success).toBe(true);
    expect(calls.create[0]).toEqual({
      model: 'gemini-omni-1.1-flash',
      input: 'a paper boat Avoid: text',
      background: true,
      response_format: { type: 'video', aspect_ratio: '16:9', resolution: '720p', duration: '8s' },
    });
    const mp4Out = out.replace(/\.png$/, '.mp4');
    expect(result.outputPath).toBe(mp4Out);
    expect(fs.readFileSync(mp4Out, 'utf8')).toBe('fake-mp4');
    expect(readJob('v1_abc')?.status).toBe('completed');
  });

  test('a -r image becomes the start frame in the input', async () => {
    const { api, calls } = fakeApi([done(mp4)]);
    const img = path.join(tmpDir(), 'f.png');
    fs.writeFileSync(img, 'png-bytes');
    await provider(api).generate({ model: 'gemini-omni', prompt: 'animate', output: path.join(tmpDir(), 'v.mp4'), referenceImages: [img], duration: 4, resolution: '360p', aspectRatio: '9:16' });
    expect(calls.create[0].input).toEqual([
      { type: 'text', text: 'animate' },
      { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mime_type: 'image/png' },
    ]);
    expect(calls.create[0].response_format).toEqual({ type: 'video', aspect_ratio: '9:16', resolution: '360p', duration: '4s' });
  });

  test('a slow job is recorded and returned as pending, not failed', async () => {
    const { api, calls } = fakeApi([{ status: 'in_progress' }]);
    const result = await provider(api).generate({ model: 'gemini-omni', prompt: 'rain', output: path.join(tmpDir(), 'v.mp4'), waitSeconds: 0 });
    expect(result).toMatchObject({ success: false, pending: true, jobId: 'v1_abc' });
    expect(readJob('v1_abc')?.status).toBe('pending');
    expect(calls.create).toHaveLength(1);
  });

  test('resume polls the interaction and never creates another', async () => {
    const { api, calls } = fakeApi([done(mp4)]);
    const out = path.join(tmpDir(), 'v.mp4');
    writeJob({ id: 'v1_abc', provider: 'google', model: 'gemini-omni', kind: 'video', output: out, submittedAt: new Date().toISOString(), status: 'pending' });
    const result = await provider(api).resume(readJob('v1_abc')!, {});
    expect(result.success).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toBe('fake-mp4');
    expect(calls.create).toHaveLength(0);
  });

  test('a poll error after submit keeps the job id and says how to resume', async () => {
    const { api } = fakeApi([]);
    api.get = async () => {
      throw Object.assign(new Error('HTTP 404: not found'), { status: 404 });
    };
    const result = await provider(api).generate({ model: 'gemini-omni', prompt: 'rain', output: path.join(tmpDir(), 'v.mp4'), waitSeconds: 30 });
    expect(result.pending).toBe(true);
    expect(result.error).toMatch(/generate --resume v1_abc/);
  });

  test('a failed interaction is recorded as failed', async () => {
    const { api } = fakeApi([{ id: 'v1_abc', status: 'failed', error: { code: 'safety' } }]);
    const result = await provider(api).generate({ model: 'gemini-omni', prompt: 'rain', output: path.join(tmpDir(), 'v.mp4') });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/interaction failed/);
    expect(readJob('v1_abc')?.status).toBe('failed');
  });
});
