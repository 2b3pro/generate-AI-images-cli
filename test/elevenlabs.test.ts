import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { ElevenLabsClient } from '../src/providers/elevenlabs-client';
import { buildDialogueInputs, ElevenLabsProvider } from '../src/providers/elevenlabs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

type Call = { url: string; init?: RequestInit };
function fake(responses: Response[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next;
  }) as typeof fetch;
  return { client: new ElevenLabsClient('k', impl), calls };
}
const audio = () => new Response('MP3', { headers: { 'content-type': 'audio/mpeg' } });
const voices = () =>
  new Response(JSON.stringify({ voices: [{ voice_id: 'AAAAAAAAAAAAAAAAAAAA', name: 'Nova' }, { voice_id: 'BBBBBBBBBBBBBBBBBBBB', name: 'Sage' }], has_more: false }), {
    headers: { 'content-type': 'application/json' },
  });
const body = (c: Call) => JSON.parse(String(c.init?.body));

beforeEach(() => writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING));
afterAll(useRealRegistry);

describe('buildDialogueInputs', () => {
  test('maps "Speaker: line" to voice ids', () => {
    expect(buildDialogueInputs('Nova: Hello.\nSage: [laughs] Hi there.', { Nova: 'A', Sage: 'B' })).toEqual([
      { text: 'Hello.', voice_id: 'A' },
      { text: '[laughs] Hi there.', voice_id: 'B' },
    ]);
  });
  test('rejects an unmapped speaker and a line without a speaker', () => {
    expect(() => buildDialogueInputs('Zed: hi', { Nova: 'A' })).toThrow(/Speaker "Zed" has no --voice/);
    expect(() => buildDialogueInputs('no speaker here', { Nova: 'A' })).toThrow(/Speaker: line/);
  });
});

describe('ElevenLabsProvider', () => {
  test('tts resolves a voice name and writes mp3', async () => {
    const { client, calls } = fake([voices(), audio()]);
    const out = path.join(tmpDir(), 'line.wav');
    const r = await new ElevenLabsProvider(client).generate({ model: 'el-tts', prompt: 'Hello there.', voices: ['Nova'], output: out });
    expect(r.success).toBe(true);
    expect(r.outputs).toEqual([out.replace(/\.wav$/, '.mp3')]);
    expect(calls[1].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/AAAAAAAAAAAAAAAAAAAA');
    expect(body(calls[1])).toEqual({ text: 'Hello there.', model_id: 'eleven_v4' });
  });

  test('tts without --voice fails before any request', async () => {
    const { client, calls } = fake([]);
    const r = await new ElevenLabsProvider(client).generate({ model: 'el-tts', prompt: 'x', output: path.join(tmpDir(), 'a.mp3') });
    expect(r.error).toMatch(/needs --voice/);
    expect(calls).toHaveLength(0);
  });

  test('dialogue sends inputs with resolved voices', async () => {
    const { client, calls } = fake([voices(), audio()]);
    await new ElevenLabsProvider(client).generate({ model: 'el-dialogue', prompt: 'A: hi\nB: hello', voices: ['A=Nova', 'B=Sage'], output: path.join(tmpDir(), 'd.mp3') });
    expect(body(calls[1])).toEqual({
      inputs: [
        { text: 'hi', voice_id: 'AAAAAAAAAAAAAAAAAAAA' },
        { text: 'hello', voice_id: 'BBBBBBBBBBBBBBBBBBBB' },
      ],
      model_id: 'eleven_v4',
    });
  });

  test('sound maps --duration and params', async () => {
    const { client, calls } = fake([audio()]);
    await new ElevenLabsProvider(client).generate({ model: 'el-sfx', prompt: 'waves on rocks', duration: 4, params: { loop: true }, output: path.join(tmpDir(), 's.mp3') });
    expect(body(calls[0])).toEqual({ text: 'waves on rocks', model_id: 'eleven_text_to_sound_v2', duration_seconds: 4, loop: true });
  });

  test('music maps --duration to milliseconds', async () => {
    const { client, calls } = fake([audio()]);
    await new ElevenLabsProvider(client).generate({ model: 'el-music', prompt: 'warm piano', duration: 20, params: { force_instrumental: true }, output: path.join(tmpDir(), 'm.mp3') });
    expect(body(calls[0])).toEqual({ prompt: 'warm piano', model_id: 'music_v2_5', music_length_ms: 20000, force_instrumental: true });
  });

  test('video-to-music uploads -r clips as videos[] with the description', async () => {
    const dir = tmpDir();
    const clip = path.join(dir, 'clip.mp4');
    fs.writeFileSync(clip, 'MP4');
    const { client, calls } = fake([audio()]);
    const r = await new ElevenLabsProvider(client).generate({ model: 'el-v2m', prompt: 'gentle, hopeful', referenceImages: [clip], output: path.join(dir, 'score.mp3') });
    expect(r.success).toBe(true);
    const form = calls[0].init?.body as FormData;
    expect(form.getAll('videos[]')).toHaveLength(1);
    expect(form.get('description')).toBe('gentle, hopeful');
    expect(form.get('model_id')).toBe('music_v2_5');
  });

  test('video-to-music without a clip fails before any request', async () => {
    const { client, calls } = fake([]);
    const r = await new ElevenLabsProvider(client).generate({ model: 'el-v2m', prompt: 'x', output: path.join(tmpDir(), 'a.mp3') });
    expect(r.error).toMatch(/needs the video clip/);
    expect(calls).toHaveLength(0);
  });
});
