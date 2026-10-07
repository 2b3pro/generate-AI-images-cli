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
      const speaker = m[1].trim();
      const voice = voiceMap[speaker];
      if (!voice) throw new Error(`Speaker "${speaker}" has no --voice ${speaker}=<voice> mapping`);
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
    const request: RequestRecord = {
      prompt_sent: options.prompt,
      params: sent,
      refs: (options.referenceImages ?? []).map((p) => ({ role: 'reference' as const, path: p })),
      draft: false,
    };
    return { success: true, outputPath: target, outputs: [target], providerModelId: spec.id, request };
  }
}
