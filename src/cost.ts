import type { GenerateOptions, ImageProvider, ModelSpec } from './types';

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
  const usd = p.unit === 'second' ? p.usd * (options.duration ?? 8) : p.usd;
  return { usd, source: 'list-price', unit: p.unit };
}
