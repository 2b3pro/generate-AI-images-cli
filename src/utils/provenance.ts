import pkg from '../../package.json';
import type { ResultJson } from '../run';

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** Embed provider, model, and the exact request into image XMP. No-op without exiftool. */
export async function stampProvenance(paths: string[], json: ResultJson): Promise<void> {
  const exiftool = Bun.which('exiftool');
  if (!exiftool) return;
  const description = JSON.stringify({
    provider: json.provider,
    model: json.model,
    provider_model_id: json.provider_model_id,
    billing: json.billing,
    request: json.request,
  });
  for (const file of paths.filter((p) => IMAGE_EXT.test(p))) {
    const proc = Bun.spawn(
      [exiftool, '-q', '-overwrite_original', `-XMP-xmp:CreatorTool=generate ${pkg.version} (${json.provider}/${json.model})`, `-XMP-dc:Description=${description}`, file],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`exiftool exited ${code} for ${file}: ${(await new Response(proc.stderr).text()).trim()}`);
  }
}
