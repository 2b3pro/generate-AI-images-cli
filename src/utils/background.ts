import sharp from 'sharp';

/**
 * Remove background using remove.bg API
 */
export async function removeBackground(inputPath: string, outputPath: string): Promise<string> {
  const apiKey = process.env.REMOVE_BG_API_KEY;

  if (!apiKey) {
    throw new Error('REMOVE_BG_API_KEY environment variable is required for background removal');
  }

  const file = Bun.file(inputPath);
  const buffer = await file.arrayBuffer();

  const formData = new FormData();
  formData.append('image_file', new Blob([buffer]), 'image.png');
  formData.append('size', 'auto');

  const response = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`remove.bg API error: ${error}`);
  }

  const resultBuffer = await response.arrayBuffer();
  await Bun.write(outputPath, resultBuffer);

  return outputPath;
}

/**
 * Add a background color to a transparent image
 */
export async function addBackgroundColor(inputPath: string, outputPath: string, hexColor: string): Promise<string> {
  // Parse hex color
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  await sharp(inputPath)
    .flatten({ background: { r, g, b } })
    .toFile(outputPath);

  return outputPath;
}

/**
 * Make image background transparent (simple color-based removal)
 */
export async function makeTransparent(inputPath: string, outputPath: string): Promise<string> {
  await sharp(inputPath)
    .ensureAlpha()
    .toFile(outputPath);

  return outputPath;
}

/**
 * Composite image onto a background image
 */
export async function compositeOnBackground(
  foregroundPath: string,
  backgroundPath: string,
  outputPath: string
): Promise<string> {
  const background = sharp(backgroundPath);
  const foreground = await sharp(foregroundPath).toBuffer();

  await background
    .composite([{ input: foreground, gravity: 'center' }])
    .toFile(outputPath);

  return outputPath;
}

/**
 * Resize image while maintaining aspect ratio
 */
export async function resizeImage(
  inputPath: string,
  outputPath: string,
  width?: number,
  height?: number
): Promise<string> {
  await sharp(inputPath)
    .resize(width, height, { fit: 'inside', withoutEnlargement: true })
    .toFile(outputPath);

  return outputPath;
}

/**
 * Convert image format
 */
export async function convertFormat(
  inputPath: string,
  outputPath: string,
  format: 'png' | 'jpg' | 'webp'
): Promise<string> {
  let pipeline = sharp(inputPath);

  switch (format) {
    case 'jpg':
      pipeline = pipeline.jpeg({ quality: 90 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: 90 });
      break;
    case 'png':
    default:
      pipeline = pipeline.png();
  }

  await pipeline.toFile(outputPath);
  return outputPath;
}
