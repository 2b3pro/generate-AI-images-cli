import OpenAI, { toFile } from 'openai';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model, ModelSpec, AspectRatio } from '../types';
import { DEFAULT_OPTIONS, ASPECT_RATIO_TO_DIMENSIONS } from '../types';
import { getModelSpec, modelsForProvider } from '../config/models';
import { getKeychainPassword } from '../utils/keychain';
import { readFileSync } from 'fs';

/**
 * Size, quality, and edit capabilities per model are declared in
 * config/models/openai.yaml (size_mode, sizes, max_edge, min_pixels,
 * max_pixels, qualities, edit). This file only interprets those flags.
 * API reference: https://developers.openai.com/api/docs/guides/image-generation
 */

/** Nearest fixed preset for models that only accept the three standard sizes. */
const ASPECT_TO_FIXED_SIZE: Record<AspectRatio, string> = {
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

const DEFAULT_MAX_EDGE = 3840;

/** Snap a dimension to the nearest positive multiple of 16. */
function snap16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16);
}

/**
 * Resolve the `size` parameter for a given model.
 * Fixed-size models are clamped to the nearest legal preset; flexible models
 * get exact aspect-correct dimensions snapped to the API's divisible-by-16
 * rule and checked against the model's edge and pixel-count limits.
 */
function resolveSize(spec: ModelSpec, options: GenerateOptions): string {
  const aspectRatio = (options.aspectRatio || DEFAULT_OPTIONS.aspectRatio) as AspectRatio;
  const explicit = options.size;

  if (spec.size_mode !== 'flexible') {
    const legal = spec.sizes ?? ['1024x1024', '1024x1536', '1536x1024', 'auto'];
    if (explicit && legal.includes(explicit)) return explicit;
    const preset = ASPECT_TO_FIXED_SIZE[aspectRatio] || '1024x1024';
    return legal.includes(preset) ? preset : legal[0];
  }

  if (explicit === 'auto') return 'auto';

  let width: number;
  let height: number;
  if (explicit && /^\d+x\d+$/.test(explicit)) {
    [width, height] = explicit.split('x').map(Number);
  } else {
    const dims = ASPECT_RATIO_TO_DIMENSIONS[aspectRatio] || { width: 1024, height: 1024 };
    width = dims.width;
    height = dims.height;
  }
  width = snap16(width);
  height = snap16(height);

  const maxEdge = spec.max_edge ?? DEFAULT_MAX_EDGE;
  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const scale = maxEdge / longest;
    width = snap16(width * scale);
    height = snap16(height * scale);
  }

  const pixels = width * height;
  if (spec.min_pixels && pixels < spec.min_pixels) {
    throw new Error(
      `Size ${width}x${height} is below ${spec.name}'s minimum of ${spec.min_pixels.toLocaleString()} pixels (e.g. 1024x1024).`
    );
  }
  if (spec.max_pixels && pixels > spec.max_pixels) {
    throw new Error(
      `Size ${width}x${height} exceeds ${spec.name}'s maximum of ${spec.max_pixels.toLocaleString()} pixels (e.g. 3840x2160).`
    );
  }
  return `${width}x${height}`;
}

/**
 * Map the CLI's quality flag onto the API enum. `standard`/`hd` are legacy
 * DALL-E names and map to medium/high; everything else passes through if the
 * model's YAML lists it.
 */
function resolveQuality(spec: ModelSpec, quality?: string): string {
  const mapped = quality === 'hd' ? 'high' : quality === 'standard' || !quality ? 'medium' : quality;
  const allowed = spec.qualities ?? ['low', 'medium', 'high', 'auto'];
  if (!allowed.includes(mapped)) {
    throw new Error(
      `Quality "${quality}" is not supported by ${spec.name}. Supported: ${allowed.join(', ')}.`
    );
  }
  return mapped;
}

export class OpenAIProvider extends BaseProvider {
  name = 'OpenAI';
  // Model list and capability flags live in config/models/openai.yaml
  models: Model[] = modelsForProvider('openai');

  private client: OpenAI;

  constructor() {
    super();
    const apiKey =
      process.env.OPENAI_API_KEY ||
      getKeychainPassword('OPENAI_API_KEY') ||
      getKeychainPassword('OPENAI_PROJECT_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable (or macOS Keychain entry) is required');
    }
    this.client = new OpenAI({ apiKey });
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const startTime = Date.now();

    try {
      const outputPath = options.output || DEFAULT_OPTIONS.output;

      const spec = getModelSpec(options.model, 'openai');
      const model = spec.id;
      const size = resolveSize(spec, options);
      const quality = resolveQuality(spec, options.quality);

      // Reference images route to /v1/images/edits on models that declare edit: true.
      if (options.referenceImages?.length && !spec.edit) {
        return {
          success: false,
          error: `${spec.name} does not support reference-image editing. Use gpt-image-2.5-sunburst, gpt-image-2.5-flare, or gpt-image-2.`,
        };
      }
      const isEditMode = !!options.referenceImages?.length && !!spec.edit;

      if (isEditMode && options.referenceImages?.length) {
        // Reference images drive edit mode
        const refImage = options.referenceImages[0];
        const imageBuffer = readFileSync(refImage);
        // Explicit mimetype required — toFile() on a raw Buffer defaults to
        // application/octet-stream, which the images.edit endpoint rejects.
        const ext = refImage.toLowerCase().split('.').pop();
        const mimeType =
          ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
          ext === 'webp' ? 'image/webp' :
          'image/png';
        const imageFile = await toFile(imageBuffer, refImage.split('/').pop() || 'image.png', {
          type: mimeType,
        });

        // Use images.edit for image editing
        // GPT image models always return base64; response_format is not sent.
        const response = await this.client.images.edit({
          model,
          image: imageFile,
          prompt: options.prompt,
          n: options.numImages || 1,
          size: size as '1024x1024' | '1536x1024' | '1024x1536',
          quality: quality as 'low' | 'medium' | 'high' | 'auto',
          ...(options.transparent && { background: 'transparent' as const }),
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
        // Standard generation. GPT image models always return base64;
        // response_format is not sent. Size/quality are cast because the
        // installed SDK's enums predate flexible sizes and the 2.5 tiers.
        const response = await this.client.images.generate({
          model,
          prompt: options.prompt,
          n: options.numImages || 1,
          size: size as '1024x1024' | '1536x1024' | '1024x1536',
          quality: quality as 'low' | 'medium' | 'high' | 'auto',
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
