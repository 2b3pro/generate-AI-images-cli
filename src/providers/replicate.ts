import Replicate from 'replicate';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { getModelSpec, modelsForProvider } from '../config/models';
import { readImageAsBase64, getMimeType } from '../utils/download';
import { getKeychainPassword } from '../utils/keychain';

/**
 * Each FLUX model on Replicate has its own input schema. The field names this
 * provider sends are declared per model under `inputs:` in
 * config/models/replicate.yaml; this file only interprets that mapping.
 */
export class ReplicateProvider extends BaseProvider {
  name = 'Replicate';
  models: Model[] = modelsForProvider('replicate');

  private client: Replicate;

  constructor() {
    super();
    const apiKey =
      process.env.REPLICATE_API_TOKEN ||
      process.env.REPLICATE_API_KEY ||
      getKeychainPassword('REPLICATE_API_TOKEN') ||
      getKeychainPassword('REPLICATE_API_KEY');
    if (!apiKey) {
      throw new Error('REPLICATE_API_TOKEN environment variable (or macOS Keychain entry) is required');
    }
    // replicate >= 1.0 returns FileOutput streams by default; we only need URLs.
    this.client = new Replicate({ auth: apiKey, useFileOutput: false });
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const startTime = Date.now();
    const spec = getModelSpec(options.model);
    const modelId = spec.id;
    const inputs = spec.inputs ?? {};

    try {
      const aspectRatio = options.aspectRatio || DEFAULT_OPTIONS.aspectRatio;
      if (spec.aspect_ratios && !spec.aspect_ratios.includes(aspectRatio)) {
        return {
          success: false,
          error: `Aspect ratio ${aspectRatio} is not supported by ${spec.name}. Supported: ${spec.aspect_ratios.join(', ')}.`,
        };
      }

      // No FLUX model accepts negative_prompt; fold it into the prompt text.
      let prompt = options.prompt;
      if (options.negativePrompt) {
        prompt += ` Avoid: ${options.negativePrompt}`;
      }

      const input: Record<string, unknown> = {
        prompt,
        aspect_ratio: aspectRatio,
        output_format: 'png',
      };

      if (inputs.output_quality) input.output_quality = 100;
      if (options.seed !== undefined) input.seed = options.seed;
      if (inputs.steps && options.steps) input[inputs.steps] = options.steps;
      if (inputs.guidance && options.guidance) input[inputs.guidance] = options.guidance;
      if (inputs.num_outputs && options.numImages && options.numImages > 1) {
        input.num_outputs = Math.min(options.numImages, 4);
      }

      // Output size: map the CLI preset onto this model's resolution enum.
      const rawSize = (options.resolution || options.size || '').toUpperCase();
      if (inputs.resolution && inputs.resolution_values && rawSize in inputs.resolution_values) {
        input[inputs.resolution] = inputs.resolution_values[rawSize];
      }

      // Reference images: array field, single field, or unsupported.
      if (options.referenceImages?.length) {
        const toDataUrl = async (p: string) =>
          `data:${getMimeType(p)};base64,${await readImageAsBase64(p)}`;

        if (inputs.images) {
          const max = inputs.max_images ?? options.referenceImages.length;
          const refs = options.referenceImages.slice(0, max);
          input[inputs.images] = await Promise.all(refs.map(toDataUrl));
        } else if (inputs.image) {
          input[inputs.image] = await toDataUrl(options.referenceImages[0]);
          if (inputs.prompt_strength) input.prompt_strength = 0.8;
        } else {
          return {
            success: false,
            error: `${spec.name} does not accept reference images. Use flux-2-pro, flux-2-max, flux-2-flex, flux-2-klein, or flux-dev.`,
          };
        }
      }

      const output = await this.client.run(modelId as `${string}/${string}`, { input });

      // Models return either a single URL or an array of URLs.
      const first = Array.isArray(output) ? output[0] : output;
      const imageUrl =
        typeof first === 'string'
          ? first
          : first && typeof (first as { url?: () => URL }).url === 'function'
          ? (first as { url: () => URL }).url().toString()
          : undefined;

      if (!imageUrl) {
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
