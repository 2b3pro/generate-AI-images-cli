import { expect, test } from 'bun:test';
import { postProcess } from '../src/postprocess';

test('a post-processing failure is returned, not thrown', async () => {
  const error = await postProcess(['/nonexistent/dir/x.png'], { addBg: '#ffffff' });
  expect(error).toMatch(/Post-processing failed for \/nonexistent\/dir\/x\.png/);
});

test('non-image outputs are skipped', async () => {
  expect(await postProcess(['/nonexistent/clip.mp4'], { addBg: '#ffffff', removeBg: true })).toBeUndefined();
});
