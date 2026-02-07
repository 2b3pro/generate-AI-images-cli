import { GoogleGenAI } from '@google/genai';
import { spawn } from 'child_process';
import path from 'path';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model, AspectRatio } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { readImageAsBase64, getMimeType } from '../utils/download';

const GEMINI_CLI = '/opt/homebrew/bin/gemini';

export class GoogleProvider extends BaseProvider {
  name = 'Google';
  models: Model[] = ['imagen-3', 'imagen-3-fast', 'imagen-4', 'nano-banana', 'nano-banana-pro'];

  private client: GoogleGenAI | null = null;

  constructor() {
    super();
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
    }
  }

  private isNanoBanana(model: Model): boolean {
    return model === 'nano-banana' || model === 'nano-banana-pro';
  }

  private runGeminiCli(prompt: string): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(GEMINI_CLI, [
        '--extensions', 'nanobanana',
        '--yolo',
        '--prompt', prompt,
      ]);

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        resolve({ stdout: stdout + stderr, exitCode: code ?? 1 });
      });
      proc.on('error', (err) => reject(err));
    });
  }

  private extractImagePath(output: string): string | null {
    // Match absolute paths ending with image extensions
    const matches = output.match(/\/[^\s`'"*?]+\.(?:png|jpg|jpeg|webp)/g);
    return matches?.length ? matches[matches.length - 1] : null;
  }

  private async generateViaCli(options: GenerateOptions): Promise<GenerationResult> {
    const startTime = Date.now();

    try {
      const aspectRatio = (options.aspectRatio || DEFAULT_OPTIONS.aspectRatio).replace(':', 'x');
      const outputPath = options.output || DEFAULT_OPTIONS.output;
      const outputDir = path.dirname(outputPath);

      // Build prompt with options appended as prose
      let fullPrompt = options.prompt;
      if (options.negativePrompt) {
        fullPrompt += ` Avoid: ${options.negativePrompt}`;
      }

      // Append all options as text directives
      const opts: string[] = [];
      opts.push(`aspect_ratio: ${aspectRatio}`);
      if (options.referenceImages?.length) {
        for (const ref of options.referenceImages) {
          opts.push(`Reference image path: ${ref}`);
        }
      }
      if (options.size) opts.push(`Resolution: ${options.size}`);
      if (options.transparent) opts.push(`Use transparent background`);
      if (options.seed) opts.push(`Random seed: ${options.seed}`);
      if (options.style && options.style !== DEFAULT_OPTIONS.style) opts.push(`Style: ${options.style}`);
      if (options.quality && options.quality !== DEFAULT_OPTIONS.quality) opts.push(`Quality: ${options.quality}`);
      if (options.numImages && options.numImages > 1) opts.push(`Generate ${options.numImages} images`);
      if (options.steps && options.steps !== DEFAULT_OPTIONS.steps) opts.push(`Inference steps: ${options.steps}`);
      if (options.guidance && options.guidance !== DEFAULT_OPTIONS.guidance) opts.push(`Guidance scale: ${options.guidance}`);
      opts.push(`Output destination: ${outputDir}`);

      fullPrompt += ' —' + opts.join(' —');

      const { stdout, exitCode } = await this.runGeminiCli(fullPrompt);

      if (exitCode !== 0) {
        return {
          success: false,
          error: `Gemini CLI exited with code ${exitCode}:\n${stdout}`,
        };
      }

      const extractedPath = this.extractImagePath(stdout);
      if (!extractedPath) {
        return {
          success: false,
          error: `Could not extract output path from Gemini CLI output:\n${stdout}`,
        };
      }

      return {
        success: true,
        outputPath: extractedPath,
        metadata: {
          model: options.model,
          prompt: options.prompt,
          duration: Date.now() - startTime,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.includes('ENOENT')) {
        return {
          success: false,
          error: `Gemini CLI not found at ${GEMINI_CLI}. Install it or use --api flag.`,
        };
      }
      return { success: false, error: msg };
    }
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    // Nano-banana models default to CLI, use API only with --api flag
    if (this.isNanoBanana(options.model) && !options.useApi) {
      return this.generateViaCli(options);
    }

    // API path — require API key
    if (!this.client) {
      return {
        success: false,
        error: 'GOOGLE_API_KEY or GEMINI_API_KEY environment variable is required. For nanobanana models, omit --api to use Gemini CLI instead.',
      };
    }

    const startTime = Date.now();

    try {
      const aspectRatio = options.aspectRatio || DEFAULT_OPTIONS.aspectRatio;
      const outputPath = options.output || DEFAULT_OPTIONS.output;

      // Map model names to Gemini API model identifiers
      const modelMap: Record<string, string> = {
        'imagen-3': 'imagen-3.0-generate-002',
        'imagen-3-fast': 'imagen-3.0-fast-generate-001',
        'imagen-4': 'gemini-3-pro-image-preview',
        'nano-banana': 'gemini-2.5-flash-image',
        'nano-banana-pro': 'gemini-3-pro-image-preview',
      };
      const modelName = modelMap[options.model] || 'gemini-2.5-flash-image';

      // Determine image size based on model and size option
      let imageSize: string | undefined;
      if (options.size) {
        const sizeUpper = options.size.toUpperCase();
        if (['1K', '2K', '4K'].includes(sizeUpper)) {
          imageSize = sizeUpper;
        }
      }

      // Build the prompt
      let enhancedPrompt = options.prompt;
      if (options.negativePrompt) {
        enhancedPrompt += ` Avoid: ${options.negativePrompt}`;
      }

      // Build contents - can be string or array with images
      let contents: string | Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;

      if (options.referenceImages?.length) {
        // Multi-part content with reference images
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

        // Add text prompt first
        parts.push({ text: enhancedPrompt });

        // Add reference images
        for (const imagePath of options.referenceImages) {
          const base64 = await readImageAsBase64(imagePath);
          const mimeType = getMimeType(imagePath);
          parts.push({
            inlineData: {
              mimeType,
              data: base64,
            },
          });
        }
        contents = parts;
      } else {
        // Simple text prompt
        contents = enhancedPrompt;
      }

      // Generate with config
      const response = await this.client.models.generateContent({
        model: modelName,
        contents,
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: aspectRatio,
            ...(imageSize && { imageSize }),
          },
        },
      });

      // Find and save the image from response
      const candidate = response.candidates?.[0];
      if (!candidate?.content?.parts?.length) {
        return {
          success: false,
          error: 'No content generated - check if the prompt was blocked',
        };
      }

      // Find the image part
      const imagePart = candidate.content.parts.find(
        (p: { inlineData?: { data?: string } }) => p.inlineData?.data
      );

      if (imagePart?.inlineData?.data) {
        await this.saveBase64Image(imagePart.inlineData.data, outputPath);
      } else {
        // Check if there's text explaining why no image
        const textPart = candidate.content.parts.find(
          (p: { text?: string }) => p.text
        );
        return {
          success: false,
          error: textPart?.text || 'No image in response - model may have declined',
        };
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

      if (errorMessage.includes('SAFETY') || errorMessage.includes('blocked')) {
        return {
          success: false,
          error: 'Content blocked by safety filters. Try rephrasing your prompt.',
        };
      }

      if (errorMessage.includes('quota') || errorMessage.includes('RESOURCE_EXHAUSTED')) {
        return {
          success: false,
          error: 'API quota exceeded. Please try again later.',
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
