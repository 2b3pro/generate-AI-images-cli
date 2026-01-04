import Replicate from 'replicate';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model, AspectRatio } from '../types';
import { ASPECT_RATIO_TO_DIMENSIONS, DEFAULT_OPTIONS } from '../types';
import { readImageAsBase64, getMimeType } from '../utils/download';

const FLUX_MODELS = {
  'flux': 'black-forest-labs/flux-1.1-pro',
  'flux-schnell': 'black-forest-labs/flux-schnell',
  'flux-pro': 'black-forest-labs/flux-pro',
} as const;

export class ReplicateProvider extends BaseProvider {
  name = 'Replicate';
  models: Model[] = ['flux', 'flux-schnell', 'flux-pro'];

  private client: Replicate;

  constructor() {
    super();
    const apiKey = process.env.REPLICATE_API_TOKEN;
    if (!apiKey) {
      throw new Error('REPLICATE_API_TOKEN environment variable is required');
    }
    this.client = new Replicate({ auth: apiKey });
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const startTime = Date.now();
    const model = options.model as keyof typeof FLUX_MODELS;
    const modelId = FLUX_MODELS[model];

    if (!modelId) {
      return {
        success: false,
        error: `Unknown Replicate model: ${options.model}`,
      };
    }

    try {
      const aspectRatio = options.aspectRatio || DEFAULT_OPTIONS.aspectRatio;
      const dimensions = ASPECT_RATIO_TO_DIMENSIONS[aspectRatio as AspectRatio];

      const input: Record<string, unknown> = {
        prompt: options.prompt,
        aspect_ratio: aspectRatio,
        output_format: 'png',
        output_quality: 100,
      };

      // Add optional parameters
      if (options.negativePrompt) {
        input.negative_prompt = options.negativePrompt;
      }

      if (options.seed !== undefined) {
        input.seed = options.seed;
      }

      if (options.steps) {
        input.num_inference_steps = options.steps;
      }

      if (options.guidance) {
        input.guidance_scale = options.guidance;
      }

      // Handle reference image (image-to-image) - Flux only supports single image
      if (options.referenceImages?.length) {
        const refImage = options.referenceImages[0];
        const base64 = await readImageAsBase64(refImage);
        const mimeType = getMimeType(refImage);
        input.image = `data:${mimeType};base64,${base64}`;
        input.prompt_strength = 0.8; // Default strength for img2img
      }

      const output = await this.client.run(modelId as `${string}/${string}`, { input });

      // Flux models return a URL or array of URLs
      const imageUrl = Array.isArray(output) ? output[0] : output;

      if (typeof imageUrl !== 'string') {
        return {
          success: false,
          error: 'Unexpected response format from Replicate',
        };
      }

      const outputPath = options.output || DEFAULT_OPTIONS.output;
      await this.saveImage(imageUrl, outputPath);

      return {
        success: true,
        outputPath,
        metadata: {
          model: options.model,
          prompt: options.prompt,
          seed: options.seed,
          duration: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }
}
