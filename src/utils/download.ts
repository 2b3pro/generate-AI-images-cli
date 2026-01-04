import { mkdir } from 'fs/promises';
import { dirname } from 'path';

export async function downloadImage(url: string, outputPath: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();

  // Ensure directory exists
  await mkdir(dirname(outputPath), { recursive: true });

  await Bun.write(outputPath, buffer);
  return outputPath;
}

export async function readImageAsBase64(path: string): Promise<string> {
  const file = Bun.file(path);
  const buffer = await file.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

export function getMimeType(path: string): string {
  const ext = path.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
    'gif': 'image/gif',
  };
  return mimeTypes[ext || ''] || 'image/png';
}
