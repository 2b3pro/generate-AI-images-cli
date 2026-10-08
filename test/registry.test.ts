import { afterAll, describe, expect, test } from 'bun:test';
import { getModelSpec, listOffers, loadModelRegistry, NoBillingPathError, resolveModel, selectSpec } from '../src/config/models';
import { DEFAULT_OPTIONS } from '../src/types';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { useRealRegistry, writeRegistry } from './helpers/registry';

afterAll(useRealRegistry);

describe('registry validation', () => {
  test('rejects a spec without billing', () => {
    expect(() => writeRegistry({ 'google.yaml': 'provider: google\nmodels:\n  x:\n    kind: image\n' })).toThrow(/billing must be metered or plan/);
  });

  test('rejects a plan-billed video model', () => {
    expect(() =>
      writeRegistry({ 'codex.yaml': 'provider: codex\nmodels:\n  v:\n    kind: video\n    billing: plan\n' })
    ).toThrow(/video models must be billing: metered/);
  });

  test('a name offered by two providers needs a routing entry', () => {
    const { 'google.yaml': g, 'atlas.yaml': a } = FIXTURE_FILES;
    expect(() => writeRegistry({ 'google.yaml': g, 'atlas.yaml': a }, '')).toThrow(/img-shared.*offered by.*routing/);
  });

  test('routing naming a provider that does not offer the model fails', () => {
    expect(() => writeRegistry(FIXTURE_FILES, 'img-shared: replicate\nvid-shared: atlas\n')).toThrow(/not offered by replicate/);
  });
});

describe('selection', () => {
  test('routing picks the active spec; provider lookup reaches the others', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(getModelSpec('img-shared').provider).toBe('google');
    expect(getModelSpec('img-shared', 'atlas').id).toBe('vendor/img/text-to-image');
    expect(listOffers('img-shared').map((s) => s.provider).sort()).toEqual(['atlas', 'codex', 'google']);
  });

  test('--via selects a provider and rejects one that does not offer the model', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(selectSpec('img-shared', { via: 'atlas' }).provider).toBe('atlas');
    expect(() => selectSpec('vid-lite', { via: 'atlas' })).toThrow(/not offered by atlas/);
  });

  test('--via combined with a contradicting --billing is rejected', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(() => selectSpec('img-shared', { via: 'atlas', billing: 'plan' })).toThrow(NoBillingPathError);
  });

  test('billing plan picks the plan offer even when routing is metered', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(selectSpec('img-shared', { billing: 'plan' }).provider).toBe('codex');
  });

  test('billing plan with no plan offer names the alternatives', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(() => selectSpec('vid-shared', { billing: 'plan' })).toThrow(/no plan-billed path for vid-shared; no plan-billed video models exist/);
    expect(() => selectSpec('tts-only', { billing: 'plan' })).toThrow(NoBillingPathError);
  });

  test('billing metered skips a plan-routed name and takes the cheapest metered offer', () => {
    writeRegistry(FIXTURE_FILES, 'img-shared: codex\nvid-shared: atlas\nshared-lite: atlas\n');
    expect(selectSpec('img-shared', { billing: 'metered' }).provider).toBe('google');
  });
});

describe('real config', () => {
  test('loads, and existing names keep their direct provider', () => {
    useRealRegistry();
    const reg = loadModelRegistry();
    expect(reg.models['nano-banana-2'].provider).toBe('google');
    expect(reg.models['nano-banana-2'].billing).toBe('metered');
    expect(reg.models['gpt-image-2'].provider).toBe('openai');
  });

  test('the October 2026 Google changes: 2.1 is the default, Omni resolves, Veo routes to Atlas', () => {
    useRealRegistry();
    const reg = loadModelRegistry();
    expect(reg.models[DEFAULT_OPTIONS.model].id).toBe('gemini-nano-banana-2.1');
    expect(resolveModel('omni')).toBe('gemini-omni');
    expect(resolveModel('gemini-omni-1.1-flash')).toBe('gemini-omni');
    expect(() => resolveModel('gemini-omni-flash-preview')).toThrow(/obsolete/);
    expect(reg.models['veo-3.1'].provider).toBe('atlas');
    expect(reg.models['veo-3.1-fast'].provider).toBe('atlas');
    expect(reg.offers['nano-banana-2'].google?.deprecated).toMatch(/nano-banana-2\.1/);
  });
});
