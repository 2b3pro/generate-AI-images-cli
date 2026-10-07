import { expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { digitalSourceType, stampProvenance } from '../src/utils/provenance';
import type { ResultJson } from '../src/run';
import { tmpDir } from './helpers/registry';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const tag = (file: string, name: string) => Bun.spawnSync(['exiftool', '-s3', name, file]).stdout.toString().trim();

function result(refs: number): ResultJson {
  return {
    provider: 'atlas', model: 'img-shared', provider_model_id: 'vendor/img/edit', billing: 'metered',
    request: { prompt_sent: 'cat', params: {}, refs: Array.from({ length: refs }, (_, i) => ({ role: 'reference', path: `r${i}.png` })), draft: false },
  } as unknown as ResultJson;
}

test('digital source type distinguishes generated from edited', () => {
  expect(digitalSourceType(result(0))).toBe('http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia');
  expect(digitalSourceType(result(1))).toBe('http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia');
});

test.skipIf(!Bun.which('exiftool'))('stamps tool and source type, and never touches an existing caption', async () => {
  const file = path.join(tmpDir(), 'o.png');
  fs.writeFileSync(file, Buffer.from(PNG, 'base64'));
  Bun.spawnSync(['exiftool', '-q', '-overwrite_original', '-XMP-dc:Description=A family portrait, 1950.', file]);
  await stampProvenance([file, path.join(tmpDir(), 'clip.mp4')], result(1));
  expect(tag(file, '-XMP-dc:Description')).toBe('A family portrait, 1950.');
  expect(tag(file, '-XMP-xmp:CreatorTool')).toMatch(/^generate \S+ \(atlas\/img-shared\)$/);
  expect(tag(file, '-XMP-iptcExt:DigitalSourceType')).toBe('http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia');
});

test.skipIf(!Bun.which('exiftool'))('a file with no caption gets none from the stamp', async () => {
  const file = path.join(tmpDir(), 'n.png');
  fs.writeFileSync(file, Buffer.from(PNG, 'base64'));
  await stampProvenance([file], result(0));
  expect(tag(file, '-XMP-dc:Description')).toBe('');
});
