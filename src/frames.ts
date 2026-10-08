import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { generateThumbnail } from './utils/thumbnail';

/** Which frame of a clip: by name, by time, or by position. */
export type FrameAt = { kind: 'first' } | { kind: 'last' } | { kind: 'time'; seconds: number } | { kind: 'percent'; percent: number };

/** One tile of a sheet: seconds into the clip, or the exact final frame. */
export type SheetTime = number | 'last';

export interface VideoProbe {
  duration?: number;
  width?: number;
  height?: number;
  /** HLG or PQ transfer: frames come out flat and grey without tone mapping */
  hdr: boolean;
}

export interface FrameResult {
  path: string;
  warnings: string[];
}

export const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);
const MAX_SHEET_FRAMES = 48;
const DEFAULT_SHEET_FRAMES = 12;
const TILE_WIDTH = 320;
const GAP = 4;
const GRID_COLUMNS = 4;

const hdrWarning = (file: string) =>
  `${path.basename(file)} is HDR (HLG or PQ); its frames may look flat and grey because generate does not tone-map`;

function requireTool(name: 'ffmpeg' | 'ffprobe'): string {
  const bin = Bun.which(name);
  if (!bin) throw new Error(`${name} not found on PATH; it is needed to read frames from video (brew install ffmpeg)`);
  return bin;
}

/** first | last | 12.5 | 1:02 | 00:01:02.5 | 40% */
export function parseFrameTime(text: string): FrameAt | undefined {
  const s = text.trim().toLowerCase();
  if (s === 'first' || s === 'last') return { kind: s };
  const pct = s.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) {
    const percent = Number(pct[1]);
    return percent <= 100 ? { kind: 'percent', percent } : undefined;
  }
  const parts = s.split(':');
  const last = parts.length - 1;
  if (last > 2 || !parts.every((p, i) => (i === last ? /^\d+(\.\d+)?$/ : /^\d+$/).test(p))) return undefined;
  if (parts.slice(1).some((p) => Number(p) >= 60)) return undefined;
  return { kind: 'time', seconds: parts.reduce((acc, p) => acc * 60 + Number(p), 0) };
}

/**
 * "clip.mp4@last" -> { path: "clip.mp4", at: last }. The selector is read only
 * after a video file name, and a file that exists under the full name wins.
 */
export function splitFrameSpec(arg: string): { path: string; at?: FrameAt } {
  const i = arg.lastIndexOf('@');
  if (i <= 0 || existsSync(arg)) return { path: arg };
  const file = arg.slice(0, i);
  const at = parseFrameTime(arg.slice(i + 1));
  return at && VIDEO_EXT.test(file) ? { path: file, at } : { path: arg };
}

/** Length, size and transfer of the first video stream; undefined if there is none. */
export function probeVideo(file: string): VideoProbe | undefined {
  const r = Bun.spawnSync(
    [requireTool('ffprobe'), '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,color_transfer:format=duration', '-of', 'json', file],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (r.exitCode !== 0) return undefined;
  try {
    const data = JSON.parse(r.stdout.toString());
    const stream = data.streams?.[0];
    if (!stream) return undefined;
    const duration = Number.parseFloat(data.format?.duration);
    return { duration: Number.isFinite(duration) ? duration : undefined, width: stream.width, height: stream.height, hdr: HDR_TRANSFERS.has(stream.color_transfer) };
  } catch {
    return undefined;
  }
}

function requireProbe(file: string): VideoProbe {
  const probe = probeVideo(file);
  if (!probe) throw new Error(`no video stream found in ${file}`);
  return probe;
}

function toSheetTime(at: FrameAt, probe: VideoProbe, file: string): SheetTime {
  if (at.kind === 'first') return 0;
  if (at.kind === 'last') return 'last';
  if (at.kind === 'percent') {
    if (probe.duration === undefined) throw new Error(`cannot take ${at.percent}% of ${file}: its length is unknown`);
    return at.percent >= 100 ? 'last' : (probe.duration * at.percent) / 100;
  }
  if (probe.duration !== undefined && at.seconds >= probe.duration) {
    throw new Error(`${at.seconds}s is past the end of ${path.basename(file)} (${probe.duration.toFixed(2)}s); use @last for the final frame`);
  }
  return at.seconds;
}

/**
 * Write one frame as PNG. "last" decodes the final second and keeps the last
 * frame written, which is exact even with B-frames or variable frame rate.
 * ffmpeg exits 0 without writing anything when a seek lands past the last
 * frame, so the file is removed first and checked after.
 */
function grab(ffmpeg: string, file: string, t: SheetTime, out: string): void {
  const input = t === 'last' ? ['-sseof', '-1', '-i', file, '-update', '1'] : ['-ss', String(t), '-i', file, '-frames:v', '1'];
  rmSync(out, { force: true });
  const r = Bun.spawnSync([ffmpeg, '-v', 'error', '-y', ...input, out], { stdout: 'ignore', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr.toString().trim()}`);
  if (!existsSync(out)) throw new Error(`ffmpeg wrote no frame at ${t === 'last' ? 'the end' : `${t}s`} of ${file}; use @last for the final frame`);
}

/** <dir>/<clip>_<suffix>.png, next to the clip. */
export function besideClip(file: string, suffix: string): string {
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}_${suffix}.png`);
}

/** clip_last.png, clip_12.5s.png, clip_40pct.png */
export function frameOutputPath(file: string, at: FrameAt): string {
  const tag = at.kind === 'time' ? `${at.seconds}s` : at.kind === 'percent' ? `${at.percent}pct` : at.kind;
  return besideClip(file, tag);
}

export function extractFrame(file: string, at: FrameAt, out: string): FrameResult {
  const ffmpeg = requireTool('ffmpeg');
  const probe = requireProbe(file);
  grab(ffmpeg, file, toSheetTime(at, probe, file), out);
  return { path: out, warnings: probe.hdr ? [hdrWarning(file)] : [] };
}

/** Poster for a clip: its middle frame, fitted inside size x size, saved as <clip>_thumb.png. */
export async function videoThumbnail(file: string, size: number): Promise<FrameResult> {
  const ffmpeg = requireTool('ffmpeg');
  const probe = requireProbe(file);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'generate-thumb-'));
  try {
    const still = path.join(tmp, 'middle.png');
    grab(ffmpeg, file, (probe.duration ?? 0) / 2, still);
    const out = await generateThumbnail(still, { size, outputPath: besideClip(file, 'thumb') });
    return { path: out, warnings: probe.hdr ? [hdrWarning(file)] : [] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Sample times are cut down to the centisecond the label shows, so a label is
 * exactly the --frame time that gives back that tile. Rounding down never
 * skips a frame: frames are more than 10 ms apart below 100 fps.
 */
const centis = (s: number) => Math.floor(s * 100 + 1e-6) / 100;

/** Evenly spaced from the first frame to the exact last one, or one frame every N seconds. */
export function sheetTimes(duration: number, o: { count?: number; every?: number }): SheetTime[] {
  let times: SheetTime[];
  if (o.every !== undefined) {
    if (!(o.every > 0)) throw new Error(`--every must be a number of seconds above 0; got ${o.every}`);
    const every = o.every;
    // The epsilon stops float error (2.1 / 0.7 = 3.0000000000000004) adding a sample at the very end.
    times = Array.from({ length: Math.ceil(duration / every - 1e-9) }, (_, i) => centis(i * every));
  } else {
    const n = o.count ?? DEFAULT_SHEET_FRAMES;
    if (!Number.isInteger(n) || n < 1) throw new Error(`a sheet needs a whole number of frames above 0; got ${n}`);
    times = n === 1 ? [centis(duration / 2)] : Array.from({ length: n }, (_, i): SheetTime => (i === n - 1 ? 'last' : centis((i * duration) / (n - 1))));
  }
  if (times.length > MAX_SHEET_FRAMES) {
    throw new Error(`that sheet would hold ${times.length} frames; the limit is ${MAX_SHEET_FRAMES}, so use a larger --every`);
  }
  return times;
}

/** The opening frame plus one per scene change (ffmpeg scene score above threshold, 0-1). */
export function sceneTimes(file: string, threshold = 0.3): number[] {
  if (!(threshold > 0 && threshold < 1)) throw new Error(`--scenes threshold must be between 0 and 1; got ${threshold}`);
  const r = Bun.spawnSync(
    [requireTool('ffmpeg'), '-hide_banner', '-i', file, '-vf', `select='gt(scene,${threshold})',showinfo`, '-fps_mode', 'vfr', '-f', 'null', '-'],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  const log = r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`ffmpeg scene detection failed on ${file}: ${log.trim().split('\n').pop()}`);
  const times = [0, ...[...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => centis(Number(m[1])))];
  if (times.length > MAX_SHEET_FRAMES) {
    throw new Error(`${times.length - 1} scene changes found; the limit is ${MAX_SHEET_FRAMES} frames, so raise the --scenes threshold`);
  }
  return times;
}

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function label(text: string, width: number, height: number): Buffer {
  const boxWidth = Math.round(text.length * 9.6 + 14);
  return Buffer.from(
    `<svg width="${width}" height="${height}"><rect x="6" y="${height - 30}" width="${boxWidth}" height="24" rx="4" fill="black" fill-opacity="0.6"/>` +
      `<text x="13" y="${height - 12}" font-family="Menlo, monospace" font-size="16" fill="white">${text}</text></svg>`
  );
}

/** Tile labelled frames into one PNG: a grid of up to four columns, or one row when strip is set. */
export async function makeSheet(file: string, times: SheetTime[], o: { strip: boolean }, out: string): Promise<FrameResult> {
  if (times.length === 0) throw new Error(`no frames to put on a sheet for ${file}`);
  const ffmpeg = requireTool('ffmpeg');
  const probe = requireProbe(file);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'generate-sheet-'));
  try {
    const shots = times.map((t, i) => {
      const shot = path.join(tmp, `${i}.png`);
      grab(ffmpeg, file, t, shot);
      return shot;
    });
    // Size tiles from a decoded frame, not the stream, so rotated phone video keeps its shape.
    const first = await sharp(shots[0]).metadata();
    const tileHeight = Math.round((TILE_WIDTH * (first.height ?? 9)) / (first.width ?? 16));
    const cols = o.strip ? shots.length : Math.min(GRID_COLUMNS, shots.length);
    const rows = Math.ceil(shots.length / cols);
    const tiles = await Promise.all(
      shots.map(async (shot, i) => ({
        input: await sharp(shot)
          .resize(TILE_WIDTH, tileHeight, { fit: 'contain', background: '#000' })
          .composite([{ input: label(times[i] === 'last' ? 'last' : clock(times[i] as number), TILE_WIDTH, tileHeight) }])
          .png()
          .toBuffer(),
        left: (i % cols) * (TILE_WIDTH + GAP),
        top: Math.floor(i / cols) * (tileHeight + GAP),
      }))
    );
    await sharp({ create: { width: cols * (TILE_WIDTH + GAP) - GAP, height: rows * (tileHeight + GAP) - GAP, channels: 3, background: '#111' } })
      .composite(tiles)
      .png()
      .toFile(out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { path: out, warnings: probe.hdr ? [hdrWarning(file)] : [] };
}

/** Sample a clip (evenly, every N seconds, or at scene changes) and tile the frames. */
export async function contactSheet(
  file: string,
  o: { count?: number; every?: number; scenes?: number | boolean; strip: boolean },
  out: string
): Promise<FrameResult> {
  let times: SheetTime[];
  if (o.scenes) {
    times = sceneTimes(file, typeof o.scenes === 'number' ? o.scenes : undefined);
  } else {
    const duration = requireProbe(file).duration;
    if (duration === undefined) throw new Error(`cannot read the length of ${file}`);
    times = sheetTimes(duration, o);
  }
  return makeSheet(file, times, { strip: o.strip }, out);
}
