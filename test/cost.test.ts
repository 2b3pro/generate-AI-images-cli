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

test.skipIf(!Bun.which('ffmpeg'))('video-to-music is priced from the clip length, not --duration', async () => {
  const { tmpDir } = await import('./helpers/registry');
  const clip = `${tmpDir()}/c.mp4`;
  Bun.spawnSync(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=10', '-pix_fmt', 'yuv420p', clip]);
  const p = await priceFor(spec({ endpoint: 'video-to-music', direct_price: { usd: 0.15, unit: 'minute' } }), provider, { model: 'm', prompt: 'p', referenceImages: [clip] });
  expect(p?.usd).toBeCloseTo((0.15 * 2) / 60, 3);
});

test('a non-finite estimate is no price at all (so a cap refuses)', async () => {
  const p = await priceFor(spec({ endpoint: 'music', direct_price: { usd: 0.15, unit: 'minute' } }), provider, { model: 'm', prompt: 'p', duration: Number.NaN });
  expect(p).toBeUndefined();
});

test('per-size list prices: image sizes and video resolutions, base price for anything unlisted', async () => {
  const img = spec({ kind: 'image', direct_price: { usd: 0.0336, unit: 'image', by_size: { '2K': 0.0504, '4K': 0.113 } } });
  expect((await priceFor(img, provider, { model: 'm', prompt: 'p', size: '4K' }))?.usd).toBe(0.113);
  expect((await priceFor(img, provider, { model: 'm', prompt: 'p', size: '4k' }))?.usd).toBe(0.113);
  expect((await priceFor(img, provider, { model: 'm', prompt: 'p', size: '512' }))?.usd).toBe(0.0336);
  expect((await priceFor(img, provider, { model: 'm', prompt: 'p' }))?.usd).toBe(0.0336);
  const vid = spec({ kind: 'video', direct_price: { usd: 0.1014, unit: 'second', by_size: { '1080p': 0.1475, '4k': 0.2858 } } });
  expect((await priceFor(vid, provider, { model: 'm', prompt: 'p', resolution: '4K', duration: 8 }))?.usd).toBeCloseTo(2.2864);
  expect((await priceFor(vid, provider, { model: 'm', prompt: 'p', resolution: '360p', duration: 5 }))?.usd).toBeCloseTo(0.507);
});

test('per-quality multipliers: hd is high, standard is medium, unlisted qualities are 1', async () => {
  const img = spec({ kind: 'image', direct_price: { usd: 0.0896, unit: 'image', by_size: { '3840x2160': 0.0841 }, by_quality: { medium: 0.34, xhigh: 1.75, max: 3.87 } } });
  const at = async (size: string, quality?: 'standard' | 'hd' | 'medium' | 'high' | 'max') => (await priceFor(img, provider, { model: 'm', prompt: 'p', size, quality }))?.usd;
  expect(await at('3840x2160', 'hd')).toBeCloseTo(0.0841);
  expect(await at('3840x2160', 'standard')).toBeCloseTo(0.0841 * 0.34);
  expect(await at('3840x2160', 'max')).toBeCloseTo(0.0841 * 3.87);
  expect(await at('3840x1648', 'hd')).toBeCloseTo(0.0896);
  expect(await at('3840x2160')).toBeCloseTo(0.0841);
});

test('real config: GPT Image 2.6 at the sizes PAI callers use', async () => {
  const { useRealRegistry } = await import('./helpers/registry');
  const { getModelSpec } = await import('../src/config/models');
  useRealRegistry();
  const s = getModelSpec('gpt-image-2.6-sunburst', 'openai');
  expect((await priceFor(s, provider, { model: s.name, prompt: 'p', size: '3840x2160', quality: 'hd' }))?.usd).toBeCloseTo(0.0841);
  expect((await priceFor(s, provider, { model: s.name, prompt: 'p', size: '3840x1648', quality: 'hd' }))?.usd).toBeCloseTo(0.0896);
});
