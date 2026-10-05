import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import { GoogleProvider, veoPollState } from '../src/providers/google';
import { readJob, writeJob } from '../src/utils/jobs';
import { tmpDir, useRealRegistry } from './helpers/registry';

function fakeClient(sequence: Array<Record<string, unknown>>) {
  const calls = { generate: 0, poll: 0 };
  const client = {
    models: {
      generateVideos: async () => {
        calls.generate++;
        return { name: 'models/veo/operations/op1', done: false };
      },
    },
    operations: {
      getVideosOperation: async () => {
        calls.poll++;
        return sequence.length > 1 ? sequence.shift()! : sequence[0];
      },
    },
    files: { download: async () => { throw new Error('not used: bytes are inline'); } },
  };
  return { client: client as unknown as GoogleGenAI, calls };
}

beforeEach(() => {
  useRealRegistry();
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});
afterAll(useRealRegistry);

describe('veoPollState', () => {
  test('maps operation states', () => {
    expect(veoPollState({ done: false })).toEqual({ status: 'processing' });
    expect(veoPollState({ done: true, error: { message: 'blocked' } })).toEqual({ status: 'failed', message: '{"message":"blocked"}' });
    expect(veoPollState({ done: true })).toEqual({ status: 'completed', urls: [] });
  });
});

describe('Veo jobs', () => {
  test('a slow job is recorded and returned as pending, not failed', async () => {
    const { client, calls } = fakeClient([{ done: false }]);
    const out = path.join(tmpDir(), 'v.mp4');
    const result = await new GoogleProvider(client).generate({ model: 'veo-3.1-lite', prompt: 'rain', output: out, waitSeconds: 0 });
    expect(result.success).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.jobId).toBe('models/veo/operations/op1');
    expect(readJob('models/veo/operations/op1')?.status).toBe('pending');
    expect(calls.generate).toBe(1);
  });

  test('resume finishes the recorded job and never calls generate', async () => {
    const video = Buffer.from('fake-mp4').toString('base64');
    const { client, calls } = fakeClient([{ done: true, response: { generatedVideos: [{ video: { videoBytes: video } }] } }]);
    const out = path.join(tmpDir(), 'v.mp4');
    writeJob({ id: 'models/veo/operations/op2', provider: 'google', model: 'veo-3.1-lite', kind: 'video', output: out, submittedAt: new Date().toISOString(), status: 'pending' });
    const result = await new GoogleProvider(client).resume(readJob('models/veo/operations/op2')!, {});
    expect(result.success).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toBe('fake-mp4');
    expect(readJob('models/veo/operations/op2')?.status).toBe('completed');
    expect(calls.generate).toBe(0);
  });
});
