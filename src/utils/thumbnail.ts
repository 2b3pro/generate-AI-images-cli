import sharp from 'sharp';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { extname, dirname, basename, join } from 'path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tiff', '.heic']);

interface ThumbnailOptions {
  size?: number;
  outputPath?: string;
}

/**
 * Generate a thumbnail for an image or file.
 * Uses sharp for images, falls back to Quick Look (qlmanage) on macOS for other file types.
 */
export async function generateThumbnail(
  inputPath: string,
  options: ThumbnailOptions = {}
): Promise<string> {
  const { size = 256 } = options;
  const ext = extname(inputPath).toLowerCase();
  const dir = dirname(inputPath);
  const name = basename(inputPath, ext);
  const outputPath = options.outputPath ?? join(dir, `${name}_thumb.png`);

  if (IMAGE_EXTENSIONS.has(ext)) {
    await generateWithSharp(inputPath, outputPath, size);
  } else if (process.platform === 'darwin') {
    await generateWithQuickLook(inputPath, outputPath, size);
  } else {
    throw new Error(`Thumbnail generation not supported for ${ext} files on this platform`);
  }

  return outputPath;
}

async function generateWithSharp(
  inputPath: string,
  outputPath: string,
  size: number
): Promise<void> {
  await sharp(inputPath)
    .resize(size, size, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .png()
    .toFile(outputPath);
}

async function generateWithQuickLook(
  inputPath: string,
  outputPath: string,
  size: number
): Promise<void> {
  const dir = dirname(outputPath);
  const expectedName = basename(inputPath) + '.png';

  try {
    execSync(`qlmanage -t -s ${size} -o "${dir}" "${inputPath}"`, {
      stdio: 'ignore',
      timeout: 10000
    });

    // qlmanage outputs as originalname.png, rename to desired output
    const qlOutput = join(dir, expectedName);
    if (existsSync(qlOutput) && qlOutput !== outputPath) {
      const { renameSync } = await import('fs');
      renameSync(qlOutput, outputPath);
    }
  } catch (error) {
    throw new Error(`Quick Look thumbnail generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
