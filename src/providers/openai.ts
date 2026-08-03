import OpenAI, { toFile } from 'openai';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model, AspectRatio, OpenAISize } from '../types';
import { DEFAULT_OPTIONS, ASPECT_RATIO_TO_DIMENSIONS } from '../types';
import { readImageAsBase64, getMimeType } from '../utils/download';
import { readFileSync } from 'fs';

/**
 * Legacy gpt-image-1 / -1-mini / -1.5 accept only three fixed sizes.
 * gpt-image-2 accepts any WxH divisible by 16, longest edge <= 3840.
 */
const FIXED_SIZE_MODELS: Model[] = ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5'];

const ASPECT_TO_FIXED_SIZE: Record<AspectRatio, OpenAISize> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:5': '1024x1536',
  '5:4': '1536x1024',
  '21:9': '1536x1024',
};

const MAX_EDGE = 3840;

/** Snap a dimension to the nearest positive multiple of 16. */
function snap16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16);
}

/**
 * Resolve the `size` parameter for a given model.
 * Fixed-size models are clamped to the nearest legal preset; gpt-image-2 gets
 * exact aspect-correct dimensions snapped to the API's divisible-by-16 rule.
 */
function resolveSize(model: Model, options: GenerateOptions): string {
  const aspectRatio = (options.aspectRatio || DEFAULT_OPTIONS.aspectRatio) as AspectRatio;

  if (FIXED_SIZE_MODELS.includes(model)) {
    const explicit = options.size as OpenAISize | undefined;
    const legal: string[] = ['1024x1024', '1024x1536', '1536x1024', 'auto'];
    if (explicit && legal.includes(explicit)) return explicit;
    return ASPECT_TO_FIXED_SIZE[aspectRatio] || '1024x1024';
  }

  // gpt-image-2: honour an explicit WxH, otherwise derive from aspect ratio.
  const explicit = options.size;
  if (explicit && /^\d+x\d+$/.test(explicit)) {
    const [w, h] = explicit.split('x').map(Number);
    return clampToMaxEdge(snap16(w), snap16(h));
  }
  if (explicit === 'auto') return 'auto';

  const dims = ASPECT_RATIO_TO_DIMENSIONS[aspectRatio] || { width: 1024, height: 1024 };
  return clampToMaxEdge(snap16(dims.width), snap16(dims.height));
}

/** Scale down proportionally if the longest edge exceeds the API limit. */
function clampToMaxEdge(width: number, height: number): string {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return `${width}x${height}`;
  const scale = MAX_EDGE / longest;
  return `${snap16(width * scale)}x${snap16(height * scale)}`;
}

/** Map the CLI's standard/hd flag onto the API's four-value quality enum. */
function resolveQuality(quality?: string): 'low' | 'medium' | 'high' | 'auto' {
  if (quality === 'low' || quality === 'medium' || quality === 'high' || quality === 'auto') {
    return quality;
  }
  return quality === 'hd' ? 'high' : 'medium';
}

export class OpenAIProvider extends BaseProvider {
  name = 'OpenAI';
  models: Model[] = ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2'];

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
      const outputPath = options.output || DEFAULT_OPTIONS.output;

      const model = options.model;
      const size = resolveSize(model, options);
      const quality = resolveQuality(options.quality);

      // gpt-image-1.5 and gpt-image-2 support reference-image editing.
      const isEditMode =
        !!options.referenceImages?.length &&
        (model === 'gpt-image-1.5' || model === 'gpt-image-2');

      if (isEditMode && options.referenceImages?.length) {
        // Reference images drive edit mode
        const refImage = options.referenceImages[0];
        const imageBuffer = readFileSync(refImage);
        const imageFile = await toFile(imageBuffer, refImage.split('/').pop() || 'image.png');

        // Use images.edit for image editing
        const response = await this.client.images.edit({
          model,
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
          model,
          prompt: options.prompt,
          n: options.numImages || 1,
          size: size as '1024x1024' | '1536x1024' | '1024x1536',
          quality,
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
