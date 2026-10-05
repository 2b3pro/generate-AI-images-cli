import path from 'path';
import type { ModelKind } from '../types';
import { RetryableError, type PollState } from '../utils/jobs';

export const ATLAS_BASE = 'https://api.atlascloud.ai/api/v1';
export type FetchLike = typeof fetch;

export class AtlasError extends Error {
  constructor(message: string, public status?: number, public code?: number | string) {
    super(message);
  }
}

const SUBMIT_PATH: Record<ModelKind, string> = {
  image: '/model/generateImage',
  video: '/model/generateVideo',
  audio: '/model/generateAudio',
};

/**
 * Dotted paths tried, in order, to read the price from POST /model/calculate.
 * Pinned against the live response shape (see test/fixtures/atlas/calculate.json).
 */
export const QUOTE_PATHS = ['data.price', 'data.total_price', 'data.cost', 'data.amount', 'price'];

function dig(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function parseQuote(json: unknown): number {
  for (const p of QUOTE_PATHS) {
    const v = dig(json, p);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  throw new Error(`Unrecognised /calculate response: ${JSON.stringify(json).slice(0, 300)}`);
}

const ERROR_TEXT: Record<string, string> = {
  '1039': 'rejected by content moderation',
};

export function describeAtlasError(code: number | string | undefined, message: string): string {
  const known = code !== undefined ? ERROR_TEXT[String(code)] : undefined;
  return known ? `${known} (Atlas error ${code})` : message;
}

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export class AtlasClient {
  constructor(private apiKey: string, private fetchImpl: FetchLike = fetch, private base = ATLAS_BASE) {}

  private headers(json: boolean): Record<string, string> {
    return json ? { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${this.apiKey}` };
  }

  /** Sent exactly once. Any failure is reported, never retried. */
  async submit(kind: ModelKind, body: Record<string, unknown>): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${SUBMIT_PATH[kind]}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    } catch (err) {
      throw new AtlasError(
        `Atlas submission state unknown (${(err as Error).message}). The job may have been created and billed; check \`generate --jobs\` and the Atlas dashboard before retrying.`
      );
    }
    if (!res.ok) throw new AtlasError(`Atlas rejected the request (HTTP ${res.status}): ${await bodyText(res)}`, res.status);
    const json = (await res.json()) as { data?: { id?: string } };
    const id = json.data?.id;
    if (!id) throw new AtlasError(`Atlas accepted the request but returned no prediction id: ${JSON.stringify(json).slice(0, 300)}`);
    return id;
  }

  async poll(id: string): Promise<PollState> {
    const res = await this.fetchImpl(`${this.base}/model/prediction/${encodeURIComponent(id)}`, { headers: this.headers(false) });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
    if (!res.ok) throw new AtlasError(`Atlas poll failed (HTTP ${res.status}): ${await bodyText(res)}`, res.status);
    const json = (await res.json()) as { data?: { status?: string; outputs?: string[]; error?: string | null; error_code?: number | string } };
    const data = json.data ?? {};
    if (data.status === 'completed') return { status: 'completed', urls: data.outputs ?? [] };
    if (data.status === 'failed' || data.status === 'timeout') {
      return { status: 'failed', code: data.error_code, message: data.error ?? `Atlas job ${data.status}` };
    }
    return { status: 'processing' };
  }

  async upload(filePath: string): Promise<string> {
    const form = new FormData();
    form.append('file', Bun.file(filePath), path.basename(filePath));
    const res = await this.fetchImpl(`${this.base}/model/uploadMedia`, { method: 'POST', headers: this.headers(false), body: form });
    if (!res.ok) throw new AtlasError(`Atlas upload failed (HTTP ${res.status}): ${await bodyText(res)}`, res.status);
    const json = (await res.json()) as { url?: string; data?: { url?: string; download_url?: string } };
    const url = json.url ?? json.data?.url ?? json.data?.download_url;
    if (!url) throw new AtlasError(`Atlas upload returned no URL: ${JSON.stringify(json).slice(0, 300)}`);
    return url;
  }

  /** Free; creates no task. */
  async calculate(body: Record<string, unknown>): Promise<number> {
    const res = await this.fetchImpl(`${this.base}/model/calculate`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    if (!res.ok) throw new AtlasError(`Atlas price check failed (HTTP ${res.status}): ${await bodyText(res)}`, res.status);
    return parseQuote(await res.json());
  }

  async fetchBytes(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new AtlasError(`Download failed (HTTP ${res.status}) for ${url}`, res.status);
    return { bytes: await res.arrayBuffer(), contentType: res.headers.get('content-type') ?? '' };
  }
}
