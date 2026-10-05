import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { AtlasClient, AtlasError, describeAtlasError, parseQuote } from '../src/providers/atlas-client';
import { RetryableError } from '../src/utils/jobs';
import { extFor, outputPathFor } from '../src/utils/download';
import { tmpDir } from './helpers/registry';

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('submit', () => {
  test('posts once to the kind endpoint and returns data.id', async () => {
    const { impl, calls } = fakeFetch([json({ data: { id: 'p1' } })]);
    const id = await new AtlasClient('k', impl).submit('video', { model: 'm', prompt: 'p' });
    expect(id).toBe('p1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.atlascloud.ai/api/v1/model/generateVideo');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ model: 'm', prompt: 'p' });
  });

  test('an HTTP error is reported once and not retried', async () => {
    const { impl, calls } = fakeFetch([json({ message: 'bad model' }, 400)]);
    await expect(new AtlasClient('k', impl).submit('image', { model: 'x' })).rejects.toBeInstanceOf(AtlasError);
    expect(calls).toHaveLength(1);
  });

  test('a network error says the submission state is unknown, and is not retried', async () => {
    const { impl, calls } = fakeFetch([new TypeError('socket hang up')]);
    await expect(new AtlasClient('k', impl).submit('image', { model: 'x' })).rejects.toThrow(/submission state unknown/);
    expect(calls).toHaveLength(1);
  });
});

describe('poll', () => {
  test('maps statuses', async () => {
    const { impl } = fakeFetch([
      json({ data: { id: 'p', status: 'processing', outputs: [] } }),
      json({ data: { id: 'p', status: 'completed', outputs: ['https://x/a.png'] } }),
      json({ data: { id: 'p', status: 'failed', outputs: [], error: 'nsfw', error_code: 1039 } }),
    ]);
    const c = new AtlasClient('k', impl);
    expect(await c.poll('p')).toEqual({ status: 'processing' });
    expect(await c.poll('p')).toEqual({ status: 'completed', urls: ['https://x/a.png'] });
    expect(await c.poll('p')).toEqual({ status: 'failed', code: 1039, message: 'nsfw' });
  });

  test('429 and 5xx are retryable; 401 is not', async () => {
    const { impl } = fakeFetch([json({}, 429), json({}, 503), json({}, 401)]);
    const c = new AtlasClient('k', impl);
    await expect(c.poll('p')).rejects.toBeInstanceOf(RetryableError);
    await expect(c.poll('p')).rejects.toBeInstanceOf(RetryableError);
    await expect(c.poll('p')).rejects.toBeInstanceOf(AtlasError);
  });
});

describe('upload and calculate', () => {
  test('upload sends multipart and accepts {url} or {data:{url}}', async () => {
    const file = path.join(tmpDir(), 'a.png');
    fs.writeFileSync(file, 'png');
    const { impl, calls } = fakeFetch([json({ url: 'https://t/1' }), json({ data: { url: 'https://t/2' } }), json({ ok: true })]);
    const c = new AtlasClient('k', impl);
    expect(await c.upload(file)).toBe('https://t/1');
    expect(calls[0].init?.body).toBeInstanceOf(FormData);
    expect(await c.upload(file)).toBe('https://t/2');
    await expect(c.upload(file)).rejects.toThrow(/no URL/);
  });

  test('parseQuote reads known shapes and refuses unknown ones', () => {
    expect(parseQuote({ data: { price: 0.04 } })).toBe(0.04);
    expect(() => parseQuote({ data: { something: 1 } })).toThrow(/Unrecognised \/calculate response/);
  });

  test('moderation code gets a plain message', () => {
    expect(describeAtlasError(1039, 'x')).toBe('rejected by content moderation (Atlas error 1039)');
    expect(describeAtlasError(undefined, 'bad resolution')).toBe('bad resolution');
  });
});

describe('output naming', () => {
  test('extension from URL, else content type', () => {
    expect(extFor('https://x/a/b.JPG?sig=1', 'image/png')).toBe('jpg');
    expect(extFor('https://x/a/b', 'video/mp4')).toBe('mp4');
    expect(extFor('https://x/a/b', 'audio/mpeg')).toBe('mp3');
    expect(extFor('https://x/a/b', 'application/octet-stream')).toBe('bin');
  });
  test('paths keep the stem and number multiple outputs', () => {
    expect(outputPathFor('/o/out.png', 0, 1, 'jpg')).toBe('/o/out.jpg');
    expect(outputPathFor('/o/out.png', 1, 3, 'png')).toBe('/o/out-2.png');
    expect(outputPathFor('/o/out', 0, 1, 'mp4')).toBe('/o/out.mp4');
  });
});
