import { expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { stampProvenance } from '../src/utils/provenance';
import type { ResultJson } from '../src/run';
import { tmpDir } from './helpers/registry';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.skipIf(!Bun.which('exiftool'))('stamps provider, model, and request into XMP', async () => {
  const file = path.join(tmpDir(), 'o.png');
  fs.writeFileSync(file, Buffer.from(PNG, 'base64'));
  const json = { provider: 'atlas', model: 'img-shared', provider_model_id: 'vendor/img/edit', billing: 'metered', request: { prompt_sent: 'cat', params: {}, refs: [], draft: false } } as unknown as ResultJson;
  await stampProvenance([file, path.join(tmpDir(), 'clip.mp4')], json);
  const tool = Bun.spawnSync(['exiftool', '-s3', '-XMP-xmp:CreatorTool', file]).stdout.toString().trim();
  expect(tool).toMatch(/^generate \S+ \(atlas\/img-shared\)$/);
  const desc = Bun.spawnSync(['exiftool', '-s3', '-XMP-dc:Description', file]).stdout.toString().trim();
  expect(JSON.parse(desc).request.prompt_sent).toBe('cat');
});
