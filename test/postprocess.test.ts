import { expect, test } from 'bun:test';
import { postProcess } from '../src/postprocess';

test('a post-processing failure is returned, not thrown', async () => {
  const { error } = await postProcess(['/nonexistent/dir/x.png'], { addBg: '#ffffff' });
  expect(error).toMatch(/Post-processing failed for \/nonexistent\/dir\/x\.png/);
});

test('image-only steps skip video and audio outputs', async () => {
  expect(await postProcess(['/nonexistent/clip.mp4', '/nonexistent/a.mp3'], { addBg: '#ffffff', removeBg: true })).toEqual({ frames: [], warnings: [] });
});
