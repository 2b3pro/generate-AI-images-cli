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
export async function priceFor(spec: ModelSpec, provider: ImageProvider, options: GenerateOptions): Promise<PriceInfo | undefined> {
  if (provider.quote) {
    const quoted = await provider.quote({ ...options, model: spec.name });
    return { usd: quoted.usd, source: 'quote', providerModelId: quoted.providerModelId };
  }
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
}
