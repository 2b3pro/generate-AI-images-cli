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
    if (contentType.includes('json')) throw new Error(`ElevenLabs returned JSON instead of audio: ${await errorMessage(res)}`);
    if (!/^audio\//.test(contentType) && !contentType.startsWith('application/octet-stream')) {
      throw new Error(`ElevenLabs response is not audio (content-type "${contentType || 'missing'}")`);
    }
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
