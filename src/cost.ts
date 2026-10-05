import type { GenerateOptions, ImageProvider, ModelSpec } from './types';

export interface PriceInfo {
  usd: number;
  source: 'quote' | 'list-price';
  unit?: string;
}

/** Provider quote when the provider can price a request; else the spec's list price. */
export async function priceFor(spec: ModelSpec, provider: ImageProvider, options: GenerateOptions): Promise<PriceInfo | undefined> {
  if (provider.quote) return { usd: await provider.quote({ ...options, model: spec.name }), source: 'quote' };
  const p = spec.direct_price;
  if (!p) return undefined;
  const usd = p.unit === 'second' ? p.usd * (options.duration ?? 8) : p.usd;
  return { usd, source: 'list-price', unit: p.unit };
}
