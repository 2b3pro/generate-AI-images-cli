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

const KNOWN_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'flac', 'ogg'];
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
};

/** File extension for a served output: the URL's own extension, else the content type. */
export function extFor(url: string, contentType: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // not a URL; use as-is
  }
  const fromUrl = pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (fromUrl && KNOWN_EXT.includes(fromUrl)) return fromUrl === 'jpeg' ? 'jpg' : fromUrl;
  return EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

/** Requested path with the served extension; "-N" suffix when there are several outputs. */
export function outputPathFor(requested: string, index: number, count: number, ext: string): string {
  const stem = requested.replace(/\.[A-Za-z0-9]+$/, '');
  return `${stem}${count > 1 ? `-${index + 1}` : ''}.${ext}`;
}
