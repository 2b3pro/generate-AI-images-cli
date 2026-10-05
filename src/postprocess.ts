import { addBackgroundColor, removeBackground } from './utils/background';
import { generateThumbnail } from './utils/thumbnail';

/**
 * Optional image post-processing (--remove-bg, --add-bg, --thumbnail).
 * Returns an error message instead of throwing, so the caller can still report
 * the outputs that were already generated and paid for.
 */
export async function postProcess(
  files: string[],
  o: { removeBg?: boolean; addBg?: string; thumbnail?: number | boolean },
  onProgress?: (status: string) => void
): Promise<string | undefined> {
  for (const file of files) {
    if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
    try {
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
        await generateThumbnail(file, { size: typeof o.thumbnail === 'number' ? o.thumbnail : 256 });
      }
    } catch (err) {
      return `Post-processing failed for ${file}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}
