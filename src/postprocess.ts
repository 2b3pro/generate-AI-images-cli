import { addBackgroundColor, removeBackground } from './utils/background';
import { generateThumbnail } from './utils/thumbnail';
import { VIDEO_EXT, besideClip, contactSheet, videoThumbnail, type FrameResult } from './frames';

export interface PostProcessResult {
  /** Thumbnails and film strips written next to the outputs */
  frames: string[];
  warnings: string[];
  error?: string;
}

const DEFAULT_FILMSTRIP_FRAMES = 6;

/**
 * Optional post-processing: --remove-bg, --add-bg and --thumbnail for images;
 * --thumbnail (middle frame) and --filmstrip for video. Returns an error
 * message instead of throwing, so the caller can still report the outputs
 * that were already generated and paid for.
 */
export async function postProcess(
  files: string[],
  o: { removeBg?: boolean; addBg?: string; thumbnail?: number | boolean; filmstrip?: number | boolean },
  onProgress?: (status: string) => void
): Promise<PostProcessResult> {
  const result: PostProcessResult = { frames: [], warnings: [] };
  const keep = (frame: FrameResult) => {
    result.frames.push(frame.path);
    for (const w of frame.warnings) if (!result.warnings.includes(w)) result.warnings.push(w);
  };
  const size = typeof o.thumbnail === 'number' ? o.thumbnail : 256;
  for (const file of files) {
    try {
      if (VIDEO_EXT.test(file)) {
        if (o.thumbnail) {
          onProgress?.('Generating thumbnail...');
          keep(await videoThumbnail(file, size));
        }
        if (o.filmstrip) {
          onProgress?.('Making film strip...');
          const count = o.filmstrip === true ? DEFAULT_FILMSTRIP_FRAMES : o.filmstrip;
          keep(await contactSheet(file, { count, strip: true }, besideClip(file, 'strip')));
        }
        continue;
      }
      if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
      if (o.removeBg) {
        onProgress?.('Removing background...');
        await removeBackground(file, file);
      }
      if (o.addBg) {
        onProgress?.('Adding background color...');
        await addBackgroundColor(file, file, o.addBg);
      }
      if (o.thumbnail) {
        onProgress?.('Generating thumbnail...');
        result.frames.push(await generateThumbnail(file, { size }));
      }
    } catch (err) {
      return { ...result, error: `Post-processing failed for ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return result;
}
