import pkg from '../../package.json';
import type { ResultJson } from '../run';

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const IPTC_SOURCE = 'http://cv.iptc.org/newscodes/digitalsourcetype/';

/** IPTC Digital Source Type: generated from scratch, or an AI edit of supplied images. */
export function digitalSourceType(json: ResultJson): string {
  const edited = (json.request?.refs?.length ?? 0) > 0;
  return IPTC_SOURCE + (edited ? 'compositeWithTrainedAlgorithmicMedia' : 'trainedAlgorithmicMedia');
}

/**
 * Mark images as made by generate. Writes only the creator tool and the IPTC
 * Digital Source Type; the human caption fields are never touched (the full
 * request lives in the job record and --json). No-op without exiftool.
 */
export async function stampProvenance(paths: string[], json: ResultJson): Promise<void> {
  const exiftool = Bun.which('exiftool');
  if (!exiftool) return;
  for (const file of paths.filter((p) => IMAGE_EXT.test(p))) {
    const proc = Bun.spawn(
      [
        exiftool,
        '-q',
        '-overwrite_original',
        `-XMP-xmp:CreatorTool=generate ${pkg.version} (${json.provider}/${json.model})`,
        `-XMP-iptcExt:DigitalSourceType=${digitalSourceType(json)}`,
        file,
      ],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`exiftool exited ${code} for ${file}: ${(await new Response(proc.stderr).text()).trim()}`);
  }
}
