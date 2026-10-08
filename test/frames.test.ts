import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { extractFrame, frameOutputPath, makeSheet, parseFrameTime, probeVideo, sceneTimes, sheetTimes, splitFrameSpec } from '../src/frames';
import { postProcess } from '../src/postprocess';
import { tmpDir } from './helpers/registry';

const HAS_FFMPEG = Boolean(Bun.which('ffmpeg') && Bun.which('ffprobe'));

describe('parseFrameTime', () => {
  test('names, seconds, clock times and percentages', () => {
    expect(parseFrameTime('first')).toEqual({ kind: 'first' });
    expect(parseFrameTime('LAST')).toEqual({ kind: 'last' });
    expect(parseFrameTime('12.5')).toEqual({ kind: 'time', seconds: 12.5 });
    expect(parseFrameTime('1:02')).toEqual({ kind: 'time', seconds: 62 });
    expect(parseFrameTime('01:00:02.5')).toEqual({ kind: 'time', seconds: 3602.5 });
    expect(parseFrameTime('40%')).toEqual({ kind: 'percent', percent: 40 });
  });

  test('rejects anything else', () => {
    for (const bad of ['', 'middle', '1:75', '1:2:3:4', '120%', '-3', '2x', '1.2.3']) expect(parseFrameTime(bad)).toBeUndefined();
  });
});

describe('splitFrameSpec', () => {
  test('splits a video path from its frame selector', () => {
    expect(splitFrameSpec('clip.mp4@last')).toEqual({ path: 'clip.mp4', at: { kind: 'last' } });
    expect(splitFrameSpec('/a/b.mov@0:03')).toEqual({ path: '/a/b.mov', at: { kind: 'time', seconds: 3 } });
  });

  test('leaves images, URLs with @ and unparseable selectors alone', () => {
    expect(splitFrameSpec('photo@2x.png')).toEqual({ path: 'photo@2x.png' });
    expect(splitFrameSpec('pose.png@last')).toEqual({ path: 'pose.png@last' });
    expect(splitFrameSpec('https://user@host/clip.mp4')).toEqual({ path: 'https://user@host/clip.mp4' });
    expect(splitFrameSpec('clip.mp4@soon')).toEqual({ path: 'clip.mp4@soon' });
  });

  test('a file that exists under the full name is a path, not a selector', () => {
    const odd = path.join(tmpDir('gen-frames-'), 'x.mp4@last');
    writeFileSync(odd, '');
    expect(splitFrameSpec(odd)).toEqual({ path: odd });
  });
});

describe('sheetTimes', () => {
  test('evenly spaced from the first frame to the last', () => {
    expect(sheetTimes(10, { count: 3 })).toEqual([0, 5, 'last']);
    expect(sheetTimes(10, { count: 1 })).toEqual([5]);
  });

  test('every N seconds', () => {
    expect(sheetTimes(10, { every: 4 })).toEqual([0, 4, 8]);
  });

  test('times are cut down to the centisecond the label shows, never rounded up past a frame', () => {
    expect(sheetTimes(7, { count: 4 })).toEqual([0, 2.33, 4.66, 'last']);
    expect(sheetTimes(2.1, { every: 0.7 })).toEqual([0, 0.7, 1.4]);
  });

  test('refuses a sheet that would be too large', () => {
    expect(() => sheetTimes(600, { every: 1 })).toThrow(/600 frames/);
  });
});

describe.skipIf(!HAS_FFMPEG)('with ffmpeg', () => {
  let dir: string;
  let coded: string;
  let scenes: string;
  let hlg: string;

  const ffmpeg = (args: string[]) => {
    const r = Bun.spawnSync(['ffmpeg', '-v', 'error', '-y', ...args], { stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  // Frame N of the coded clip has TV-range luma 16+4N, which reads back as about 4N*255/219 in a PNG.
  const expectedLuma = (n: number) => (4 * n * 255) / 219;
  const luma = async (png: string) => (await sharp(png).greyscale().stats()).channels[0].mean;

  beforeAll(() => {
    dir = tmpDir('gen-frames-');
    coded = path.join(dir, 'coded.mp4');
    scenes = path.join(dir, 'scenes.mp4');
    hlg = path.join(dir, 'hlg.mp4');
    // 48 frames at 24 fps with B-frames: the case where "last frame" tends to land one early
    ffmpeg(['-f', 'lavfi', '-i', "color=black:s=64x36:r=24:d=2,format=yuv420p,geq=lum='16+N*4':cb=128:cr=128", '-c:v', 'libx264', '-bf', '3', coded]);
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=black:s=160x90:r=24:d=1',
      '-f', 'lavfi', '-i', 'color=gray:s=160x90:r=24:d=1',
      '-f', 'lavfi', '-i', 'color=white:s=160x90:r=24:d=1',
      '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0,format=yuv420p', '-c:v', 'libx264', scenes,
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=160x90:r=24:d=0.5,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc,format=yuv420p', '-c:v', 'libx264', hlg]);
  });

  test('probeVideo reads duration, size and HDR transfer', () => {
    expect(probeVideo(coded)).toMatchObject({ duration: 2, width: 64, height: 36, hdr: false });
    expect(probeVideo(hlg)).toMatchObject({ hdr: true });
    expect(probeVideo(path.join(dir, 'missing.mp4'))).toBeUndefined();
  });

  test('extracts the first, a timed, a percentage and the exact last frame', async () => {
    const at = (spec: string) => extractFrame(coded, parseFrameTime(spec)!, path.join(dir, `f-${spec.replace('%', 'pct')}.png`));
    expect(await luma(at('first').path)).toBeCloseTo(expectedLuma(0), 0);
    expect(Math.abs((await luma(at('1').path)) - expectedLuma(24))).toBeLessThan(2);
    expect(Math.abs((await luma(at('50%').path)) - expectedLuma(24))).toBeLessThan(2);
    expect(Math.abs((await luma(at('last').path)) - expectedLuma(47))).toBeLessThan(2);
  });

  test('a time past the end is refused instead of writing nothing', () => {
    expect(() => extractFrame(coded, { kind: 'time', seconds: 5 }, path.join(dir, 'past.png'))).toThrow(/past the end/);
    expect(existsSync(path.join(dir, 'past.png'))).toBe(false);
  });

  test('an HDR clip extracts with a warning', () => {
    const r = extractFrame(hlg, { kind: 'first' }, path.join(dir, 'hlg.png'));
    expect(existsSync(r.path)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/HDR/);
  });

  test('sceneTimes finds the cuts and keeps the opening frame', () => {
    const times = sceneTimes(scenes);
    expect(times).toHaveLength(3);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(1, 1);
    expect(times[2]).toBeCloseTo(2, 1);
  });

  test('makeSheet tiles labelled frames as a strip or a grid', async () => {
    const strip = await makeSheet(scenes, [0, 1.5, 'last'], { strip: true }, path.join(dir, 'strip.png'));
    expect(await sharp(strip.path).metadata()).toMatchObject({ width: 3 * 320 + 2 * 4, height: 180 });
    const grid = await makeSheet(scenes, [0, 0.5, 1, 1.5, 2, 'last'], { strip: false }, path.join(dir, 'grid.png'));
    expect(await sharp(grid.path).metadata()).toMatchObject({ width: 4 * 320 + 3 * 4, height: 2 * 180 + 4 });
  });

  test('frameOutputPath names the still after the clip and the moment', () => {
    expect(frameOutputPath('/v/clip.mp4', { kind: 'last' })).toBe('/v/clip_last.png');
    expect(frameOutputPath('/v/clip.mp4', { kind: 'time', seconds: 12.5 })).toBe('/v/clip_12.5s.png');
    expect(frameOutputPath('/v/clip.mp4', { kind: 'percent', percent: 40 })).toBe('/v/clip_40pct.png');
  });

  test('postProcess makes a thumbnail and a film strip for a video output', async () => {
    const out = await postProcess([coded], { thumbnail: 32, filmstrip: 4 });
    expect(out.error).toBeUndefined();
    expect(out.frames).toEqual([path.join(dir, 'coded_thumb.png'), path.join(dir, 'coded_strip.png')]);
    expect(await sharp(out.frames[0]).metadata()).toMatchObject({ width: 32, height: 18 });
    // The thumbnail is the middle of the clip, not the opening frame
    expect(Math.abs((await luma(path.join(dir, 'coded_thumb.png'))) - expectedLuma(24))).toBeLessThan(3);
  });
});
