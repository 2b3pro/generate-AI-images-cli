import OpenAI, { toFile } from 'openai';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model, AspectRatio, OpenAISize } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { readImageAsBase64, getMimeType } from '../utils/download';
import { readFileSync } from 'fs';

const ASPECT_TO_OPENAI_SIZE: Record<AspectRatio, OpenAISize> = {
  '1:1': '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '4:3': '1024x1024', // Closest match
  '3:4': '1024x1024', // Closest match
  '3:2': '1792x1024', // Closest match
  '2:3': '1024x1792', // Closest match
  '4:5': '1024x1024', // Closest match
  '5:4': '1024x1024', // Closest match
  '21:9': '1792x1024', // Closest match (ultrawide)
};

export class OpenAIProvider extends BaseProvider {
  name = 'OpenAI';
  models: Model[] = ['gpt-image-1', 'gpt-image-1.5'];

  private client: OpenAI;

  constructor() {
    super();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    this.client = new OpenAI({ apiKey });
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const startTime = Date.now();

    try {
      const aspectRatio = options.aspectRatio || DEFAULT_OPTIONS.aspectRatio;
      const size = options.size as OpenAISize || ASPECT_TO_OPENAI_SIZE[aspectRatio as AspectRatio] || '1024x1024';
      const outputPath = options.output || DEFAULT_OPTIONS.output;

      const model = options.model === 'gpt-image-1.5' ? 'gpt-image-1' : 'gpt-image-1';
      const isEditMode = options.referenceImages?.length && options.model === 'gpt-image-1.5';

      if (isEditMode && options.referenceImages?.length) {
        // gpt-image-1.5 with reference images uses edit mode
        const refImage = options.referenceImages[0];
        const imageBuffer = readFileSync(refImage);
        const imageFile = await toFile(imageBuffer, refImage.split('/').pop() || 'image.png');

        // Use images.edit for image editing
        const response = await this.client.images.edit({
          model: 'gpt-image-1',
          image: imageFile,
          prompt: options.prompt,
          n: options.numImages || 1,
          size: size as '1024x1024' | '1536x1024' | '1024x1536',
        });

        const imageData = response.data?.[0];

        if (!imageData) {
          return {
            success: false,
            error: 'No image data in response',
          };
        }

        if (imageData.b64_json) {
          await this.saveBase64Image(imageData.b64_json, outputPath);
        } else if (imageData.url) {
          await this.saveImage(imageData.url, outputPath);
        } else {
          return {
            success: false,
            error: 'No image data in response',
          };
        }
      } else {
        // Standard generation
        const response = await this.client.images.generate({
          model: 'gpt-image-1',
          prompt: options.prompt,
          n: options.numImages || 1,
          size: size as '1024x1024' | '1536x1024' | '1024x1536',
          quality: options.quality === 'hd' ? 'high' : 'medium',
          background: options.transparent ? 'transparent' : 'opaque',
          output_format: 'png',
        });

        const imageData = response.data?.[0];

        if (!imageData) {
          return {
            success: false,
            error: 'No image data in response',
          };
        }

        if (imageData.b64_json) {
          await this.saveBase64Image(imageData.b64_json, outputPath);
        } else if (imageData.url) {
          await this.saveImage(imageData.url, outputPath);
        } else {
          return {
            success: false,
            error: 'No image data in response',
          };
        }
      }

      return {
        success: true,
        outputPath,
        metadata: {
          model: options.model,
          prompt: options.prompt,
          duration: Date.now() - startTime,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      // Handle specific OpenAI errors
      if (error instanceof OpenAI.APIError) {
        return {
          success: false,
          error: `OpenAI API Error (${error.status}): ${error.message}`,
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
