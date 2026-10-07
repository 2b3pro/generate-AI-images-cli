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
