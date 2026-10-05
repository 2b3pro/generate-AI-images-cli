#!/usr/bin/env bun
/**
 * Ask Atlas's free /model/calculate endpoint to price a minimal request for
 * every model id declared in config/models/atlas.yaml (base, edit, i2v, r2v).
 * /calculate creates no task and charges nothing. An unknown id fails here
 * instead of failing (or misbehaving) on a paid request.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadModelRegistry } from '../src/config/models';
import { AtlasClient } from '../src/providers/atlas-client';
import { resolveApiKey } from '../src/utils/keychain';
import type { ModelSpec } from '../src/types';

const key = resolveApiKey(['ATLASCLOUD_API_KEY']);
if (!key) {
  console.error('ATLASCLOUD_API_KEY is required');
  process.exit(1);
}
const client = new AtlasClient(key);

const png = path.join(os.tmpdir(), 'verify-atlas.png');
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const imageUrl = await client.upload(png);

const atlasSpecs = Object.values(loadModelRegistry().offers)
  .map((o) => o.atlas)
  .filter((s): s is ModelSpec => Boolean(s));

let failures = 0;
for (const spec of atlasSpecs) {
  const inputs = spec.inputs ?? {};
  const promptField = inputs.prompt ?? 'prompt';
  const variants: Array<[string, string | undefined, Record<string, unknown>]> = [
    ['base', spec.id, {}],
    ['edit', spec.edit_id, inputs.images ? { [inputs.images]: [imageUrl] } : inputs.image ? { [inputs.image]: imageUrl } : {}],
    ['i2v', spec.i2v_id, inputs.image ? { [inputs.image]: imageUrl } : {}],
    ['r2v', spec.r2v_id, inputs.images ? { [inputs.images]: [imageUrl] } : {}],
  ];
  for (const [label, id, extra] of variants) {
    if (!id) continue;
    try {
      const usd = await client.calculate({ model: id, [promptField]: 'verification', ...extra });
      console.log(`ok    ${spec.name.padEnd(20)} ${label.padEnd(5)} ${id}  $${usd}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${spec.name.padEnd(20)} ${label.padEnd(5)} ${id}  ${(err as Error).message.slice(0, 160)}`);
    }
  }
}
process.exit(failures ? 1 : 0);
