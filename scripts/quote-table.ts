#!/usr/bin/env bun
/**
 * Price every model name offered by more than one provider, at standard
 * settings, and print a markdown table. Atlas rows come from /calculate (free);
 * direct rows come from direct_price in YAML; plan rows show $0 marginal.
 * This script never edits config/routing.yaml.
 */
import { loadModelRegistry } from '../src/config/models';
import { getOrCreateProvider } from '../src/providers';
import { priceFor } from '../src/cost';
import type { Billing, GenerateOptions, ModelSpec, Provider } from '../src/types';

export interface QuoteRow {
  model: string;
  provider: Provider;
  billing: Billing;
  usd: number | null;
  basis: string;
  routed: boolean;
  source?: string;
}

const cell = (v: string) => v.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');

export function formatQuoteTable(rows: QuoteRow[]): string {
  const routedPrice = new Map(rows.filter((r) => r.routed).map((r) => [r.model, r.usd]));
  const lines = ['| Model | Provider | Billing | USD | Basis | vs routed | Source |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const base = routedPrice.get(r.model);
    const usd = r.billing === 'plan' ? '0 marginal (plan limits)' : r.usd === null ? 'n/a' : r.usd.toFixed(4);
    let delta = 'n/a';
    if (!r.routed && r.billing === 'metered' && r.usd !== null && base) delta = `${Math.round(((r.usd - base) / base) * 100)}%`;
    if (r.routed) delta = 'routed';
    lines.push(`| ${r.model} | ${r.provider}${r.routed ? ' (routed)' : ''} | ${r.billing} | ${usd} | ${cell(r.basis)} | ${delta} | ${cell(r.source ?? '')} |`);
  }
  return lines.join('\n');
}

function standardOptions(spec: ModelSpec): GenerateOptions {
  if (spec.kind === 'video') return { model: spec.name, prompt: 'price check', duration: 8, resolution: '720p', aspectRatio: '16:9' };
  if (spec.kind === 'audio') return { model: spec.name, prompt: 'price check, thirty seconds', params: { duration: 30 } };
  return { model: spec.name, prompt: 'price check', size: '1K', aspectRatio: '16:9' };
}

/** /calculate is free and creates nothing, so a 429 may simply be retried (after a pause). */
async function withRateLimitRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      const result = await fn();
      await Bun.sleep(1500);
      return result;
    } catch (err) {
      if (i >= attempts || !/HTTP 429/.test((err as Error).message)) throw err;
      await Bun.sleep(5000 * 2 ** (i - 1));
    }
  }
}

if (import.meta.main) {
  const reg = loadModelRegistry();
  const rows: QuoteRow[] = [];
  for (const [name, offers] of Object.entries(reg.offers)) {
    const specs = Object.values(offers) as ModelSpec[];
    if (specs.length < 2) continue;
    for (const spec of specs) {
      const routed = reg.models[name].provider === spec.provider;
      try {
        const price = await withRateLimitRetry(() => priceFor(spec, getOrCreateProvider(spec.provider), standardOptions(spec)));
        rows.push({
          model: name,
          provider: spec.provider,
          billing: spec.billing,
          usd: price?.usd ?? null,
          basis: price ? (price.source === 'quote' ? `/calculate ${spec.kind === 'video' ? '8s 720p' : spec.kind === 'audio' ? '30s' : '1K 16:9'}` : `list price per ${price.unit}`) : 'no price recorded',
          routed,
          source: spec.direct_price?.source ? `${spec.direct_price.source} (${spec.direct_price.checked ?? 'undated'})` : undefined,
        });
      } catch (err) {
        rows.push({ model: name, provider: spec.provider, billing: spec.billing, usd: null, basis: `error: ${(err as Error).message.slice(0, 80)}`, routed });
      }
    }
  }
  console.log(formatQuoteTable(rows));
}
