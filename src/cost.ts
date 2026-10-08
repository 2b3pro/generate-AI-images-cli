import type { GenerateOptions, ImageProvider, ModelSpec } from './types';
import { ENDPOINT_MAX_SECONDS } from './types';

export interface PriceInfo {
  usd: number;
  source: 'quote' | 'list-price';
  unit?: string;
  /** The provider model variant the price applies to, when the provider reports it */
  providerModelId?: string;
}

/** Provider quote when the provider can price a request; else the spec's list price. */
/** Total length of the clips in seconds via ffprobe; undefined if unknown (then the endpoint maximum applies). */
function clipLength(paths: string[]): number | undefined {
  if (paths.length === 0 || !Bun.which('ffprobe')) return undefined;
  let total = 0;
  for (const p of paths) {
    const r = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]);
    const seconds = Number.parseFloat(r.stdout.toString().trim());
    if (!Number.isFinite(seconds)) return undefined;
    total += seconds;
  }
  return total;
}

export async function priceFor(spec: ModelSpec, provider: ImageProvider, options: GenerateOptions): Promise<PriceInfo | undefined> {
  if (provider.quote) {
    const quoted = await provider.quote({ ...options, model: spec.name });
    return { usd: quoted.usd, source: 'quote', providerModelId: quoted.providerModelId };
  }
  const p = spec.direct_price;
  if (!p) return undefined;
  let usd = p.usd;
  const size = options.resolution ?? options.size;
  if (size && p.by_size) usd = p.by_size[size] ?? p.by_size[size.toUpperCase()] ?? p.by_size[size.toLowerCase()] ?? usd;
  if (p.unit === 'second') usd *= options.duration ?? 8;
  if (p.unit === 'minute') {
    const clipSeconds = spec.endpoint === 'video-to-music' ? clipLength(options.referenceImages ?? []) : undefined;
    const seconds = clipSeconds ?? options.duration ?? (spec.endpoint ? ENDPOINT_MAX_SECONDS[spec.endpoint] : undefined) ?? 60;
    usd = (usd * seconds) / 60;
  }
  if (p.unit === '1k_chars') usd = (usd * options.prompt.length) / 1000;
  if (!Number.isFinite(usd)) return undefined;
  return { usd, source: 'list-price', unit: p.unit };
}
