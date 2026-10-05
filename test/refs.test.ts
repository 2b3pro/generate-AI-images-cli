import { afterAll, describe, expect, test } from 'bun:test';
import { getModelSpec } from '../src/config/models';
import { parseParams } from '../src/params';
import { attachNotes, parseRefArg, renderRefLabels, validateRefs } from '../src/refs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { useRealRegistry, writeRegistry } from './helpers/registry';

afterAll(useRealRegistry);

describe('parsing', () => {
  test('parses role=path, keeping "=" inside the path', () => {
    expect(parseRefArg('identity=/tmp/a=b.png')).toEqual({ role: 'identity', source: '/tmp/a=b.png' });
  });
  test('rejects unknown roles and missing parts', () => {
    expect(() => parseRefArg('face=/tmp/a.png')).toThrow(/Unknown reference role "face"/);
    expect(() => parseRefArg('/tmp/a.png')).toThrow(/expects <role>=<path\|url>/);
    expect(() => parseRefArg('start=')).toThrow(/needs a path or URL/);
  });
  test('attaches 1-based notes', () => {
    const refs = attachNotes([parseRefArg('identity=a.png'), parseRefArg('style=b.png')], ['2=palette only']);
    expect(refs[1].note).toBe('palette only');
    expect(() => attachNotes(refs, ['3=x'])).toThrow(/has no matching --ref/);
  });
  test('params parse JSON values and fall back to strings', () => {
    expect(parseParams(['duration=5', 'sound=true', 'voice=Aria', 'cfg={"a":1}'])).toEqual({ duration: 5, sound: true, voice: 'Aria', cfg: { a: 1 } });
    expect(() => parseParams(['novalue'])).toThrow(/--param expects key=value/);
  });
});

describe('validation', () => {
  test('model without ref caps rejects role refs', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    const check = validateRefs(getModelSpec('img-shared', 'google'), [parseRefArg('identity=a.png')], {});
    expect(check.errors[0]).toMatch(/does not accept role-typed references/);
  });
  test('count and unknown-role limits', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    const spec = getModelSpec('img-shared', 'atlas');
    const refs = ['identity=a', 'identity=b', 'identity=c', 'start=d'].map(parseRefArg);
    const { errors } = validateRefs(spec, refs, {});
    expect(errors).toContain('img-shared (atlas) accepts at most 2 "identity" reference(s); got 3');
    expect(errors).toContain('img-shared (atlas) does not accept a "start" reference');
    expect(errors.some((e) => e.includes('in total'))).toBe(false);
  });
  test('total image-reference cap', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    const spec = getModelSpec('img-shared', 'atlas');
    const refs = ['identity=a', 'identity=b', 'object=c', 'object=d'].map(parseRefArg);
    expect(validateRefs(spec, refs, {}).errors).toContain('img-shared (atlas) accepts at most 3 reference images in total; got 4');
  });
  test('exclusive groups, forced duration, people warning', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    const spec = getModelSpec('vid-shared', 'atlas');
    const excl = validateRefs(spec, ['start=a', 'identity=b'].map(parseRefArg), {});
    expect(excl.errors).toContain('vid-shared (atlas) cannot combine start and identity references');
    const forced = validateRefs(spec, ['identity=a', 'identity=b', 'identity=c'].map(parseRefArg), { duration: 5 });
    expect(forced.errors).toEqual([]);
    expect(forced.forcedDuration).toBe(8);
    expect(forced.warnings.some((w) => w.includes('overridden to 8s'))).toBe(true);
    expect(forced.warnings.some((w) => w.includes('unstable with more people'))).toBe(true);
  });
});

describe('labels', () => {
  const refs = attachNotes(['identity=a', 'style=b'].map(parseRefArg), ['1=the man in the centre']);
  test('at-index', () => {
    expect(renderRefLabels('at-index', refs)).toBe(
      '@Image1: identity reference: keep this person or character recognisably the same (the man in the centre).\n' +
        '@Image2: style reference: match its look, not its content.'
    );
  });
  test('wan-numbered', () => {
    expect(renderRefLabels('wan-numbered', refs).split('\n')[1]).toBe('Image 2: style reference: match its look, not its content.');
  });
  test('prose (default)', () => {
    expect(renderRefLabels(undefined, refs)).toBe(
      'Reference images: the first image is the identity reference: keep this person or character recognisably the same (the man in the centre); the second image is the style reference: match its look, not its content.'
    );
  });
  test('empty refs render nothing', () => {
    expect(renderRefLabels('prose', [])).toBe('');
  });
});
