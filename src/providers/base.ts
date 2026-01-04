import type { GenerateOptions, GenerationResult, ImageProvider, Model } from '../types';
import { downloadImage } from '../utils/download';

export abstract class BaseProvider implements ImageProvider {
  abstract name: string;
  abstract models: Model[];

  abstract generate(options: GenerateOptions): Promise<GenerationResult>;

  protected async saveImage(url: string, outputPath: string): Promise<string> {
    return downloadImage(url, outputPath);
  }

  protected async saveBase64Image(base64: string, outputPath: string): Promise<string> {
    const buffer = Buffer.from(base64, 'base64');
    await Bun.write(outputPath, buffer);
    return outputPath;
  }
}
