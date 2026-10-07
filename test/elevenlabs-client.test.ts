import { describe, expect, test } from 'bun:test';
import { ElevenLabsClient, resolveVoice } from '../src/providers/elevenlabs-client';

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  }) as typeof fetch;
  return { impl, calls };
}
const audio = (body = 'MP3') => new Response(body, { headers: { 'content-type': 'audio/mpeg' } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('requests', () => {
  test('posts JSON with the xi-api-key header and returns audio bytes', async () => {
    const { impl, calls } = fakeFetch([audio()]);
    const r = await new ElevenLabsClient('k', impl).postJson('/v1/sound-generation', { text: 'rain' });
    expect(new TextDecoder().decode(r.bytes)).toBe('MP3');
    expect(r.contentType).toBe('audio/mpeg');
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/sound-generation');
    expect((calls[0].init?.headers as Record<string, string>)['xi-api-key']).toBe('k');
  });

  test('a JSON error body is an error, never audio, even with HTTP 200', async () => {
    const { impl } = fakeFetch([json({ detail: { message: 'quota exceeded' } }, 401), json({ detail: { message: 'odd' } }, 200)]);
    const c = new ElevenLabsClient('k', impl);
    await expect(c.postJson('/v1/music', { prompt: 'p' })).rejects.toThrow(/HTTP 401.*quota exceeded/);
    await expect(c.postJson('/v1/music', { prompt: 'p' })).rejects.toThrow(/returned JSON instead of audio.*odd/);
  });

  test('lists voices across pages', async () => {
    const { impl, calls } = fakeFetch([
      json({ voices: [{ voice_id: 'a1', name: 'Nova' }], has_more: true, next_page_token: 't2' }),
      json({ voices: [{ voice_id: 'b2', name: 'Sage' }], has_more: false, next_page_token: null }),
    ]);
    const voices = await new ElevenLabsClient('k', impl).listVoices();
    expect(voices.map((v) => v.voice_id)).toEqual(['a1', 'b2']);
    expect(calls[1].url).toContain('next_page_token=t2');
  });
});

describe('resolveVoice', () => {
  const voices = [{ voice_id: 'AAAAAAAAAAAAAAAAAAAA', name: 'Nova' }, { voice_id: 'BBBBBBBBBBBBBBBBBBBB', name: 'Sage' }, { voice_id: 'CCCCCCCCCCCCCCCCCCCC', name: 'sage' }];
  test('an id is used as is', () => expect(resolveVoice('AAAAAAAAAAAAAAAAAAAA', voices)).toBe('AAAAAAAAAAAAAAAAAAAA'));
  test('a unique name resolves case-insensitively', () => expect(resolveVoice('nova', voices)).toBe('AAAAAAAAAAAAAAAAAAAA'));
  test('an ambiguous name fails and lists candidates', () => expect(() => resolveVoice('SAGE', voices)).toThrow(/ambiguous.*BBBB.*CCCC/));
  test('an unknown name fails and lists available names', () => expect(() => resolveVoice('Zed', voices)).toThrow(/No voice named "Zed".*Nova/));
});
