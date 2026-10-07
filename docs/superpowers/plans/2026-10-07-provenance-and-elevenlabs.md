# Provenance Fix (1.4.1) and ElevenLabs Provider (1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the provenance stamp from overwriting image captions, and add ElevenLabs (speech with your own voices, dialogue, sound effects, music, video-to-music) as a direct, metered provider.

**Architecture:** 1.4.1 changes only `src/utils/provenance.ts`. 1.5 adds an `elevenlabs` provider: a thin HTTP client (`elevenlabs-client.ts`) plus a provider that maps one model spec's `endpoint` (`tts`, `dialogue`, `sound`, `music`, `video-to-music`) to one synchronous request returning audio bytes. Voices are referenced by id or name through `--voice`. Prices use new list-price units (`1k_chars`, `minute`) in `cost.ts`.

**Tech Stack:** Bun 1.3, TypeScript, commander, `bun:test`, `fetch`, `FormData`, exiftool.

**Spec:** `docs/specs/2026-10-04-atlas-provider-design.md`, section "Addendum (2026-10-07)".

## Global Constraints

- `bunx tsc --noEmit` passes at the end of every task; no new runtime dependencies.
- Public repo: no personal names, paths, voice ids, or account details in code, config, fixtures, or docs. No em-dashes in docs.
- ElevenLabs base URL `https://api.elevenlabs.io`; auth header `xi-api-key`; key `ELEVENLABS_API_KEY` from env, then macOS Keychain, via `resolveApiKey`.
- All ElevenLabs endpoints used are synchronous and return audio bytes; they create no job records.
- A provenance write never modifies `XMP-dc:Description`, `EXIF:ImageDescription`, or `IPTC:Caption-Abstract`.
- Automated tests never touch the network. The live smoke (Task 6) spends under USD 0.10 and runs only after the owner's go-ahead.
- Existing flags and behaviour are unchanged; `--voice` and `--voices` are additive.

## Review Focus

1. **An image that already has a human caption is stamped**: the caption is byte-identical afterwards. Pinned in Task 1.
2. **A voice name matches two voices, or none**: the command fails before any paid call and lists the candidates. Pinned in Task 3 (`resolveVoice`).
3. **A dialogue line names a speaker with no `--voice` mapping**: rejected before the request, naming the speaker. Pinned in Task 4 (`buildDialogueInputs`).
4. **`--max-cost` on sound or music without `--duration`**: the estimate uses the endpoint maximum, so a low cap refuses instead of guessing low. Pinned in Task 2.
5. **ElevenLabs returns a JSON error with HTTP 200 or 4xx**: reported as an error with the API's message, never written to disk as audio. Pinned in Task 3.

---

### Task 1: Provenance stays out of the caption (1.4.1)

**Files:**
- Modify: `src/utils/provenance.ts`
- Modify: `test/provenance.test.ts`

**Interfaces:**
- Produces: `stampProvenance(paths: string[], json: ResultJson): Promise<void>` (same signature); `digitalSourceType(json: ResultJson): string`.

- [ ] **Step 1: Replace `test/provenance.test.ts`**

```ts
import { expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { digitalSourceType, stampProvenance } from '../src/utils/provenance';
import type { ResultJson } from '../src/run';
import { tmpDir } from './helpers/registry';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const tag = (file: string, name: string) => Bun.spawnSync(['exiftool', '-s3', name, file]).stdout.toString().trim();

function result(refs: number): ResultJson {
  return {
    provider: 'atlas', model: 'img-shared', provider_model_id: 'vendor/img/edit', billing: 'metered',
    request: { prompt_sent: 'cat', params: {}, refs: Array.from({ length: refs }, (_, i) => ({ role: 'reference', path: `r${i}.png` })), draft: false },
  } as unknown as ResultJson;
}

test('digital source type distinguishes generated from edited', () => {
  expect(digitalSourceType(result(0))).toBe('http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia');
  expect(digitalSourceType(result(1))).toBe('http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia');
});

test.skipIf(!Bun.which('exiftool'))('stamps tool and source type, and never touches an existing caption', async () => {
  const file = path.join(tmpDir(), 'o.png');
  fs.writeFileSync(file, Buffer.from(PNG, 'base64'));
  Bun.spawnSync(['exiftool', '-q', '-overwrite_original', '-XMP-dc:Description=A family portrait, 1950.', file]);
  await stampProvenance([file, path.join(tmpDir(), 'clip.mp4')], result(1));
  expect(tag(file, '-XMP-dc:Description')).toBe('A family portrait, 1950.');
  expect(tag(file, '-XMP-xmp:CreatorTool')).toMatch(/^generate \S+ \(atlas\/img-shared\)$/);
  expect(tag(file, '-XMP-iptcExt:DigitalSourceType')).toBe('http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia');
});

test.skipIf(!Bun.which('exiftool'))('a file with no caption gets none from the stamp', async () => {
  const file = path.join(tmpDir(), 'n.png');
  fs.writeFileSync(file, Buffer.from(PNG, 'base64'));
  await stampProvenance([file], result(0));
  expect(tag(file, '-XMP-dc:Description')).toBe('');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/provenance.test.ts`
Expected: FAIL (`digitalSourceType` is not exported; the caption is replaced by JSON).

- [ ] **Step 3: Replace `src/utils/provenance.ts`**

```ts
import pkg from '../../package.json';
import type { ResultJson } from '../run';

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const IPTC_SOURCE = 'http://cv.iptc.org/newscodes/digitalsourcetype/';

/** IPTC Digital Source Type: generated from scratch, or an AI edit of supplied images. */
export function digitalSourceType(json: ResultJson): string {
  const edited = (json.request?.refs?.length ?? 0) > 0;
  return IPTC_SOURCE + (edited ? 'compositeWithTrainedAlgorithmicMedia' : 'trainedAlgorithmicMedia');
}

/**
 * Mark images as made by generate. Writes only the creator tool and the IPTC
 * Digital Source Type; the human caption fields are never touched (the full
 * request lives in the job record and --json). No-op without exiftool.
 */
export async function stampProvenance(paths: string[], json: ResultJson): Promise<void> {
  const exiftool = Bun.which('exiftool');
  if (!exiftool) return;
  for (const file of paths.filter((p) => IMAGE_EXT.test(p))) {
    const proc = Bun.spawn(
      [
        exiftool,
        '-q',
        '-overwrite_original',
        `-XMP-xmp:CreatorTool=generate ${pkg.version} (${json.provider}/${json.model})`,
        `-XMP-iptcExt:DigitalSourceType=${digitalSourceType(json)}`,
        file,
      ],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`exiftool exited ${code} for ${file}: ${(await new Response(proc.stderr).text()).trim()}`);
  }
}
```

- [ ] **Step 4: Run tests, version, typecheck**

Run: `sed -i '' 's/"version": "1.4.0"/"version": "1.4.1"/' package.json && bun test && bunx tsc --noEmit`
Expected: all PASS (provenance 3/3), tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/provenance.ts test/provenance.test.ts package.json
git commit -m "fix(provenance): stamp creator tool and IPTC source type, never the caption (1.4.1)"
```

---

### Task 2: Types, registry, and list-price units

**Files:**
- Modify: `src/types.ts`, `src/config/models.ts:20`, `src/cost.ts`
- Test: `test/cost.test.ts`

**Interfaces:**
- Produces: `Provider` gains `'elevenlabs'`; `ElevenEndpoint = 'tts' | 'dialogue' | 'sound' | 'music' | 'video-to-music'`; `ModelSpec.endpoint?: ElevenEndpoint`; `GenerateOptions.voices?: string[]`; `ENDPOINT_MAX_SECONDS`; `priceFor` handles `unit: '1k_chars'` and `unit: 'minute'`.

- [ ] **Step 1: Write the failing test** in `test/cost.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { priceFor } from '../src/cost';
import type { ImageProvider, ModelSpec } from '../src/types';

const provider = { name: 'x', models: [], generate: async () => ({ success: true }) } as ImageProvider;
const spec = (over: Partial<ModelSpec>): ModelSpec => ({ name: 'm', provider: 'elevenlabs', id: 'm', kind: 'audio', billing: 'metered', aliases: [], ...over });

test('per-1k-character prices scale with prompt length', async () => {
  const p = await priceFor(spec({ endpoint: 'tts', direct_price: { usd: 0.08, unit: '1k_chars' } }), provider, { model: 'm', prompt: 'x'.repeat(2500) });
  expect(p?.usd).toBeCloseTo(0.2);
});

test('per-minute prices use --duration', async () => {
  const p = await priceFor(spec({ endpoint: 'music', direct_price: { usd: 0.15, unit: 'minute' } }), provider, { model: 'm', prompt: 'p', duration: 30 });
  expect(p?.usd).toBeCloseTo(0.075);
});

test('without --duration the estimate assumes the endpoint maximum', async () => {
  const sfx = await priceFor(spec({ endpoint: 'sound', direct_price: { usd: 0.12, unit: 'minute' } }), provider, { model: 'm', prompt: 'p' });
  expect(sfx?.usd).toBeCloseTo(0.06);
  const music = await priceFor(spec({ endpoint: 'music', direct_price: { usd: 0.15, unit: 'minute' } }), provider, { model: 'm', prompt: 'p' });
  expect(music?.usd).toBeCloseTo(1.5);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/cost.test.ts`
Expected: FAIL (type errors on `'elevenlabs'`/`endpoint`, and the minute/1k_chars units are not handled).

- [ ] **Step 3: Implement**

In `src/types.ts`: change the `Provider` union to add `| 'elevenlabs'`; after `export type LabelStyle ...` add

```ts
/** ElevenLabs endpoint a model spec maps to */
export type ElevenEndpoint = 'tts' | 'dialogue' | 'sound' | 'music' | 'video-to-music';

/** Longest output each ElevenLabs endpoint can return, for worst-case price estimates */
export const ENDPOINT_MAX_SECONDS: Partial<Record<ElevenEndpoint, number>> = { sound: 30, music: 600, 'video-to-music': 600 };
```

In `ModelSpec`, after `timeout_seconds?: number;` add `/** ElevenLabs: which endpoint this model uses */\n  endpoint?: ElevenEndpoint;`. In `GenerateOptions`, after `draft?: boolean;` add `/** --voice values: an id or name (TTS), or Speaker=<id|name> pairs (dialogue) */\n  voices?: string[];`.

In `src/config/models.ts` line 20 add `'elevenlabs'` to `KNOWN_PROVIDERS`.

Replace the body of `priceFor` in `src/cost.ts` after the provider-quote branch:

```ts
  const p = spec.direct_price;
  if (!p) return undefined;
  let usd = p.usd;
  if (p.unit === 'second') usd = p.usd * (options.duration ?? 8);
  if (p.unit === 'minute') {
    const seconds = options.duration ?? (spec.endpoint ? ENDPOINT_MAX_SECONDS[spec.endpoint] : undefined) ?? 60;
    usd = (p.usd * seconds) / 60;
  }
  if (p.unit === '1k_chars') usd = (p.usd * options.prompt.length) / 1000;
  return { usd, source: 'list-price', unit: p.unit };
```

and add `import { ENDPOINT_MAX_SECONDS } from './types';` (value import) next to the type import.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config/models.ts src/cost.ts test/cost.test.ts
git commit -m "feat(types): elevenlabs provider, endpoint field, --voice values, minute and 1k-char pricing"
```

---

### Task 3: ElevenLabs HTTP client

**Files:**
- Create: `src/providers/elevenlabs-client.ts`
- Test: `test/elevenlabs-client.test.ts`

**Interfaces:**
- Produces: `ELEVEN_BASE`; `class ElevenLabsClient { constructor(apiKey: string, fetchImpl?: typeof fetch, base?: string); postJson(path: string, body: Record<string, unknown>): Promise<{ bytes: ArrayBuffer; contentType: string }>; postForm(path: string, form: FormData): Promise<{ bytes: ArrayBuffer; contentType: string }>; listVoices(): Promise<{ voice_id: string; name: string; category?: string }[]> }`; `resolveVoice(ref: string, voices: { voice_id: string; name: string }[]): string`.

- [ ] **Step 1: Write the failing test** in `test/elevenlabs-client.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/elevenlabs-client.test.ts`
Expected: FAIL with "Cannot find module '../src/providers/elevenlabs-client'".

- [ ] **Step 3: Implement `src/providers/elevenlabs-client.ts`**

```ts
export const ELEVEN_BASE = 'https://api.elevenlabs.io';

type Voice = { voice_id: string; name: string; category?: string };

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { detail?: { message?: string } | string; message?: string };
    const d = j.detail;
    return (typeof d === 'string' ? d : d?.message) ?? j.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export class ElevenLabsClient {
  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch, private base = ELEVEN_BASE) {}

  private async audio(res: Response): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok) throw new Error(`ElevenLabs request failed (HTTP ${res.status}): ${await errorMessage(res)}`);
    if (contentType.includes('application/json')) throw new Error(`ElevenLabs returned JSON instead of audio: ${await errorMessage(res)}`);
    return { bytes: await res.arrayBuffer(), contentType };
  }

  async postJson(path: string, body: Record<string, unknown>): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.audio(res);
  }

  async postForm(path: string, form: FormData): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method: 'POST', headers: { 'xi-api-key': this.apiKey }, body: form });
    return this.audio(res);
  }

  async listVoices(): Promise<Voice[]> {
    const voices: Voice[] = [];
    let token: string | null = null;
    do {
      const url = new URL(`${this.base}/v2/voices`);
      url.searchParams.set('page_size', '100');
      if (token) url.searchParams.set('next_page_token', token);
      const res = await this.fetchImpl(url.toString(), { headers: { 'xi-api-key': this.apiKey } });
      if (!res.ok) throw new Error(`ElevenLabs voice list failed (HTTP ${res.status}): ${await errorMessage(res)}`);
      const page = (await res.json()) as { voices?: Voice[]; has_more?: boolean; next_page_token?: string | null };
      voices.push(...(page.voices ?? []));
      token = page.has_more ? page.next_page_token ?? null : null;
    } while (token);
    return voices;
  }
}

/** A voice id (20+ alphanumerics) is used as is; otherwise a case-insensitive exact name match must be unique. */
export function resolveVoice(ref: string, voices: { voice_id: string; name: string }[]): string {
  if (/^[A-Za-z0-9]{20,}$/.test(ref)) return ref;
  const matches = voices.filter((v) => v.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0].voice_id;
  if (matches.length > 1) throw new Error(`Voice name "${ref}" is ambiguous: ${matches.map((m) => `${m.name} (${m.voice_id})`).join(', ')}. Pass the voice id.`);
  throw new Error(`No voice named "${ref}". Available: ${voices.map((v) => v.name).join(', ') || 'none'} (see generate --voices)`);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/elevenlabs-client.test.ts && bunx tsc --noEmit`
Expected: PASS, tsc 0.

- [ ] **Step 5: Commit**

```bash
git add src/providers/elevenlabs-client.ts test/elevenlabs-client.test.ts
git commit -m "feat(elevenlabs): HTTP client with audio-only success, paged voice list, voice resolution"
```

---

### Task 4: ElevenLabs provider

**Files:**
- Create: `src/providers/elevenlabs.ts`
- Modify: `src/providers/index.ts` (register)
- Test: `test/elevenlabs.test.ts`
- Modify: `test/fixtures/registry.ts` (add an `elevenlabs.yaml` fixture)

**Interfaces:**
- Consumes: `ElevenLabsClient`, `resolveVoice` (Task 3); `extFor`, `outputPathFor` (existing `src/utils/download.ts`); `getModelSpec(model, 'elevenlabs')`.
- Produces: `buildDialogueInputs(prompt: string, voiceMap: Record<string, string>): { text: string; voice_id: string }[]`; `class ElevenLabsProvider implements ImageProvider` with `constructor(client?: ElevenLabsClient)`.

- [ ] **Step 1: Add the fixture and write the failing test**

Append to `FIXTURE_FILES` in `test/fixtures/registry.ts`:

```ts
  'elevenlabs.yaml': `
provider: elevenlabs
models:
  el-tts:
    id: eleven_v4
    kind: audio
    billing: metered
    endpoint: tts
  el-dialogue:
    id: eleven_v4
    kind: audio
    billing: metered
    endpoint: dialogue
  el-sfx:
    id: eleven_text_to_sound_v2
    kind: audio
    billing: metered
    endpoint: sound
  el-music:
    id: music_v2_5
    kind: audio
    billing: metered
    endpoint: music
  el-v2m:
    id: music_v2_5
    kind: audio
    billing: metered
    endpoint: video-to-music
`,
```

`test/elevenlabs.test.ts`:

```ts
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
const voices = () => new Response(JSON.stringify({ voices: [{ voice_id: 'AAAAAAAAAAAAAAAAAAAA', name: 'Nova' }, { voice_id: 'BBBBBBBBBBBBBBBBBBBB', name: 'Sage' }], has_more: false }), { headers: { 'content-type': 'application/json' } });
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
    expect(body(calls[1])).toEqual({ inputs: [{ text: 'hi', voice_id: 'AAAAAAAAAAAAAAAAAAAA' }, { text: 'hello', voice_id: 'BBBBBBBBBBBBBBBBBBBB' }], model_id: 'eleven_v4' });
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/elevenlabs.test.ts`
Expected: FAIL with "Cannot find module '../src/providers/elevenlabs'".

- [ ] **Step 3: Implement `src/providers/elevenlabs.ts`**

```ts
import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base';
import { ElevenLabsClient, resolveVoice } from './elevenlabs-client';
import type { GenerateOptions, GenerationResult, Model, RequestRecord } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { getModelSpec, modelsForProvider } from '../config/models';
import { resolveApiKey } from '../utils/keychain';
import { extFor, outputPathFor } from '../utils/download';

/** "Speaker: line" per non-empty line -> dialogue inputs. Every speaker needs a --voice Speaker=<ref>. */
export function buildDialogueInputs(prompt: string, voiceMap: Record<string, string>): { text: string; voice_id: string }[] {
  return prompt
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:]{1,40}):\s*(.+)$/);
      if (!m) throw new Error(`Dialogue lines must look like "Speaker: line"; got "${line.slice(0, 60)}"`);
      const voice = voiceMap[m[1].trim()];
      if (!voice) throw new Error(`Speaker "${m[1].trim()}" has no --voice ${m[1].trim()}=<voice> mapping`);
      return { text: m[2].trim(), voice_id: voice };
    });
}

function defaultClient(): ElevenLabsClient {
  const key = resolveApiKey(['ELEVENLABS_API_KEY']);
  if (!key) throw new Error('ELEVENLABS_API_KEY environment variable (or macOS Keychain entry) is required for ElevenLabs models');
  return new ElevenLabsClient(key);
}

export class ElevenLabsProvider extends BaseProvider {
  name = 'ElevenLabs';
  models: Model[] = modelsForProvider('elevenlabs');
  private client: ElevenLabsClient;
  private voiceCache?: { voice_id: string; name: string }[];

  constructor(client?: ElevenLabsClient) {
    super();
    this.client = client ?? defaultClient();
  }

  private async voice(ref: string): Promise<string> {
    if (/^[A-Za-z0-9]{20,}$/.test(ref)) return ref;
    this.voiceCache ??= await this.client.listVoices();
    return resolveVoice(ref, this.voiceCache);
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const spec = getModelSpec(options.model, 'elevenlabs');
    const output = options.output ?? DEFAULT_OPTIONS.audioOutput;
    const params = options.params ?? {};
    let result: { bytes: ArrayBuffer; contentType: string };
    let sent: Record<string, unknown> = {};
    try {
      switch (spec.endpoint) {
        case 'tts': {
          const ref = options.voices?.[0];
          if (!ref) return { success: false, error: `${spec.name} needs --voice <name|id> (see generate --voices)` };
          const voiceId = await this.voice(ref);
          sent = { text: options.prompt, model_id: spec.id, ...params };
          result = await this.client.postJson(`/v1/text-to-speech/${voiceId}`, sent);
          break;
        }
        case 'dialogue': {
          const map: Record<string, string> = {};
          for (const pair of options.voices ?? []) {
            const eq = pair.indexOf('=');
            if (eq <= 0) return { success: false, error: `Dialogue --voice values look like Speaker=<name|id>; got "${pair}"` };
            map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
          }
          for (const k of Object.keys(map)) map[k] = await this.voice(map[k]);
          sent = { inputs: buildDialogueInputs(options.prompt, map), model_id: spec.id, ...params };
          result = await this.client.postJson('/v1/text-to-dialogue', sent);
          break;
        }
        case 'sound':
          sent = { text: options.prompt, model_id: spec.id, ...(options.duration !== undefined && { duration_seconds: options.duration }), ...params };
          result = await this.client.postJson('/v1/sound-generation', sent);
          break;
        case 'music':
          sent = { prompt: options.prompt, model_id: spec.id, ...(options.duration !== undefined && { music_length_ms: Math.round(options.duration * 1000) }), ...params };
          result = await this.client.postJson('/v1/music', sent);
          break;
        case 'video-to-music': {
          const clips = options.referenceImages ?? [];
          if (clips.length === 0) return { success: false, error: `${spec.name} needs the video clip(s) to score, passed with -r` };
          const form = new FormData();
          for (const clip of clips) form.append('videos[]', Bun.file(fs.realpathSync(clip)), path.basename(clip));
          if (options.prompt) form.append('description', options.prompt);
          form.append('model_id', spec.id);
          for (const [k, v] of Object.entries(params)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
          sent = { description: options.prompt, model_id: spec.id, videos: clips, ...params };
          result = await this.client.postForm('/v1/music/video-to-music', form);
          break;
        }
        default:
          return { success: false, error: `${spec.name} has no ElevenLabs endpoint configured` };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    const target = outputPathFor(output, 0, 1, extFor('', result.contentType));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await Bun.write(target, result.bytes);
    const request: RequestRecord = { prompt_sent: options.prompt, params: sent, refs: (options.referenceImages ?? []).map((p) => ({ role: 'reference', path: p })), draft: false };
    return { success: true, outputPath: target, outputs: [target], providerModelId: spec.id, request };
  }
}
```

Register it in `src/providers/index.ts`: import `ElevenLabsProvider` from `./elevenlabs`, add `case 'elevenlabs': provider = new ElevenLabsProvider(); break;` and add it to the export list.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all PASS, tsc 0. (Existing registry tests keep passing: the new fixture names do not overlap existing ones.)

- [ ] **Step 5: Commit**

```bash
git add src/providers/elevenlabs.ts src/providers/index.ts test/elevenlabs.test.ts test/fixtures/registry.ts
git commit -m "feat(elevenlabs): provider for tts, dialogue, sound effects, music, video-to-music"
```

---

### Task 5: CLI flags, catalog, docs, version

**Files:**
- Modify: `src/cli.ts` (`--voice`, `--voices`)
- Create: `config/models/elevenlabs.yaml`
- Modify: `config/models/atlas.yaml` (remove `elevenlabs-v3-tts`)
- Modify: `README.md`, `package.json`
- Test: `test/cli.test.ts` (one case)

- [ ] **Step 1: Write the failing CLI test** Append to `test/cli.test.ts`:

```ts
test('--voice reaches the provider (a malformed dialogue pair is rejected before any network call)', () => {
  const r = cli(['-m', 'el-dialogue', 'A: hi', '--voice', 'A', '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toMatch(/look like Speaker=<name\|id>/);
});
```

and add `ELEVENLABS_API_KEY: 'test-key'` to the `env` object in that file's `beforeEach`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/cli.test.ts`
Expected: the new case FAILS: commander rejects the unknown `--voice` option, so stdout holds no JSON document.

- [ ] **Step 3: Implement the flags**

In `src/cli.ts`, add the imports `import { ElevenLabsClient } from './providers/elevenlabs-client';` and `import { resolveApiKey } from './utils/keychain';`, then after the `--jobs` early branch add:

```ts
if (process.argv.includes('--voices')) {
  const key = resolveApiKey(['ELEVENLABS_API_KEY']);
  if (!key) {
    console.error(chalk.red('ELEVENLABS_API_KEY is required for --voices'));
    process.exit(1);
  }
  const voices = await new ElevenLabsClient(key).listVoices();
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(voices) + '\n');
  else for (const v of voices) console.log(`${v.voice_id}  ${v.name}${v.category ? chalk.dim(`  (${v.category})`) : ''}`);
  process.exit(0);
}
```

Add options next to `--ref`:

```ts
  .option('--voice <ref>', 'ElevenLabs voice id or name; for dialogue, Speaker=<id|name> (repeatable)', collect, [])
  .option('--voices', 'List ElevenLabs voices on your account and exit')
```

and pass `voices: opts.voice as string[],` inside the `options` object given to `runVariations`.

- [ ] **Step 4: Catalog**

Create `config/models/elevenlabs.yaml`:

```yaml
# ElevenLabs direct API (https://api.elevenlabs.io). Synchronous; returns audio.
# Field names from the API reference, read 2026-10-07.
#   endpoint   tts | dialogue | sound | music | video-to-music
#   billing    metered (per character or per minute, list prices below)
# TTS/dialogue need --voice (id or name; `generate --voices` lists yours).
# Sound and music take --duration (seconds). Video-to-music takes the clip with -r.

provider: elevenlabs

models:
  eleven-v4:
    id: eleven_v4
    kind: audio
    billing: metered
    endpoint: tts
    description: ElevenLabs v4 speech in your own, cloned, or library voices. --voice required. Inline tags like [laughs].
    direct_price: { usd: 0.08, unit: 1k_chars, source: "https://elevenlabs.io/pricing/api", checked: 2026-10-07 }

  eleven-v3:
    id: eleven_v3
    kind: audio
    billing: metered
    endpoint: tts
    description: ElevenLabs v3 speech. --voice required.
    direct_price: { usd: 0.08, unit: 1k_chars, source: "https://elevenlabs.io/pricing/api", checked: 2026-10-07 }

  eleven-dialogue:
    id: eleven_v4
    kind: audio
    billing: metered
    endpoint: dialogue
    description: Multi-voice dialogue. Prompt lines "Speaker: line"; --voice Speaker=<voice> per speaker (max 10). Keep under 2,000 characters.
    direct_price: { usd: 0.08, unit: 1k_chars, source: "https://elevenlabs.io/pricing/api", checked: 2026-10-07 }

  eleven-sfx:
    id: eleven_text_to_sound_v2
    kind: audio
    billing: metered
    endpoint: sound
    description: Sound effects and foley, 0.5-30 s (--duration). --param loop=true for a seamless loop.
    direct_price: { usd: 0.12, unit: minute, source: "https://elevenlabs.io/pricing/api", checked: 2026-10-07 }

  eleven-music:
    id: music_v2_5
    kind: audio
    billing: metered
    endpoint: music
    description: Eleven Music v2.5, 3-600 s (--duration). --param force_instrumental=true for no vocals.
    direct_price: { usd: 0.15, unit: minute, source: "https://elevenlabs.io/pricing/api", checked: 2026-10-07 }

  eleven-video-to-music:
    id: music_v2_5
    kind: audio
    billing: metered
    endpoint: video-to-music
    description: Scores a video clip (-r clip.mp4, up to 10 clips / 600 s). Prompt is an optional description of the music.
    direct_price: { usd: 0.15, unit: minute, source: "https://elevenlabs.io/pricing/api", checked: 2026-10-07 }
```

Remove the `elevenlabs-v3-tts` entry and its comment from `config/models/atlas.yaml`, and add one line to its trailing notes: `# Removed 2026-10-07: elevenlabs/v3/text-to-speech (preset voices only; the direct ElevenLabs provider covers it).`

- [ ] **Step 5: README and version**

Add an `elevenlabs | metered | Speech in your own voices, dialogue, sound effects, music, video-to-music` row to the providers table, `ELEVENLABS_API_KEY` to the credentials table, and two examples to the CLI help text:

```ts
  ${chalk.dim('# Sound effects for a silent clip, then a score fitted to it')}
  $ generate -m eleven-sfx "waves crashing on rocks, distant gulls" --duration 5 -o waves.mp3
  $ generate -m eleven-video-to-music "calm, hopeful piano" -r clip.mp4 -o score.mp3
```

Run: `sed -i '' 's/"version": "1.4.1"/"version": "1.5.0"/' package.json && bun test && bunx tsc --noEmit && bun run build && bun dist/cli.js --list-models | grep -A1 'eleven-'`
Expected: all PASS; tsc 0; the six ElevenLabs models listed.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts config README.md package.json test/cli.test.ts
git commit -m "feat(cli): --voice and --voices; ElevenLabs catalog; drop Atlas ElevenLabs TTS; release 1.5.0"
```

---

### Task 6: Live smoke (STOP: owner go-ahead, under USD 0.10)

Run after approval, in a scratch directory, using the merged build:

```bash
generate --voices | head -5
generate -m eleven-v4 "This is a short test of my voice." --voice <one of your voices> -o line.mp3 --max-cost 0.01 --json
generate -m eleven-sfx "waves crashing on rocks, distant gulls" --duration 3 -o waves.mp3 --max-cost 0.01 --json
generate -m eleven-music "warm solo piano, hopeful" --duration 10 --param force_instrumental=true -o piano.mp3 --max-cost 0.05 --json
generate -m eleven-video-to-music "calm, hopeful" -r <the 3 s Kling clip> -o score.mp3 --json
generate -m nano-banana-2 "a lighthouse" -o lh.png --json && exiftool -s -XMP-dc:Description -XMP-xmp:CreatorTool -XMP-iptcExt:DigitalSourceType lh.*
```

Check: every result `ok: true`; `ffprobe` durations match (about 3 s, about 10 s, about the clip length); the lighthouse has an empty description, the creator tool, and `trainedAlgorithmicMedia`. Stop and report on any failure.
