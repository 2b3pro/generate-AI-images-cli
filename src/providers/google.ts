import { GoogleGenAI } from '@google/genai';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { readImageAsBase64, getMimeType } from '../utils/download';
import { getKeychainPassword } from '../utils/keychain';

function findGeminiCli(): string {
  if (process.env.GEMINI_CLI_PATH && fs.existsSync(process.env.GEMINI_CLI_PATH)) {
    return process.env.GEMINI_CLI_PATH;
  }
  const candidates = [
    '/Users/ianashen/.nvm/versions/node/v25.5.0/bin/gemini',
    '/opt/homebrew/bin/gemini',
    '/usr/local/bin/gemini',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'gemini';
}

function resolveApiKey(): string | undefined {
  // 1. Check environment variables
  if (process.env.GOOGLE_API_KEY?.trim()) return process.env.GOOGLE_API_KEY.trim();
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();

  // 2. Pull from macOS Keychain
  const keychainKey =
    getKeychainPassword('GEMINI_API_KEY') ||
    getKeychainPassword('GOOGLE_API_KEY') ||
    getKeychainPassword('NANOBANANA_API_KEY');
  if (keychainKey) return keychainKey;

  // 3. Fallback: check nanobanana extension .env or local environment files
  const home = process.env.HOME || '';
  const searchPaths = [
    path.join(home, '.gemini', 'extensions', 'nanobanana', '.env'),
    path.join(home, '.gemini', 'antigravity-cli', '.env'),
    path.join(process.cwd(), '.env'),
  ];

  for (const envPath of searchPaths) {
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^(?:GOOGLE_API_KEY|GEMINI_API_KEY|NANOBANANA_API_KEY)=(.*)$/m);
        if (match && match[1]?.trim()) {
          return match[1].trim();
        }
      }
    } catch {
      // Continue searching
    }
  }

  return undefined;
}

export class GoogleProvider extends BaseProvider {
  name = 'Google';
  models: Model[] = [
    'nano-banana-2',
    'nano-banana-pro',
    'nano-banana-2-lite',
    'nano-banana',
    'veo-3.1',
    'veo-3.1-lite',
  ];

  private client: GoogleGenAI | null = null;

  constructor() {
    super();
    const apiKey = resolveApiKey();
    if (apiKey) {
      // Ensure vertexai: false when using Gemini API keys
      delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      delete process.env.GOOGLE_CLOUD_PROJECT;
      this.client = new GoogleGenAI({ apiKey, vertexai: false });
    }
  }

  private isNanoBanana(model: Model): boolean {
    return (
      model === 'nano-banana' ||
      model === 'nano-banana-2' ||
      model === 'nano-banana-pro' ||
      model === 'nano-banana-2-lite'
    );
  }

  private isVideo(model: Model): boolean {
    return model === 'veo-3.1' || model === 'veo-3.1-lite';
  }

  private runGeminiCli(prompt: string): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const cliBin = findGeminiCli();
      const proc = spawn(cliBin, [
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
      if (options.resolution || options.size) {
        opts.push(`Resolution: ${options.resolution || options.size}`);
      }
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
        const cliBin = findGeminiCli();
        return {
          success: false,
          error: `Gemini CLI not found at ${cliBin}. Install it or use --api flag.`,
        };
      }
      return { success: false, error: msg };
    }
  }

  private async generateVideo(options: GenerateOptions): Promise<GenerationResult> {
    if (!this.client) {
      return {
        success: false,
        error: 'GOOGLE_API_KEY or GEMINI_API_KEY environment variable (or macOS Keychain entry) is required for Veo video generation.',
      };
    }

    const startTime = Date.now();

    try {
      const modelMap: Record<string, string> = {
        'veo-3.1': 'veo-3.1-generate-preview',
        'veo-3.1-lite': 'veo-3.1-lite-generate-preview',
      };
      const modelName = modelMap[options.model] || 'veo-3.1-generate-preview';

      // Output path
      let outputPath = options.output || DEFAULT_OPTIONS.videoOutput;
      if (/\.(png|jpg|jpeg|webp)$/i.test(outputPath)) {
        outputPath = outputPath.replace(/\.(png|jpg|jpeg|webp)$/i, '.mp4');
      }

      // Aspect ratio: Veo supports 16:9 and 9:16
      let aspectRatio = options.aspectRatio || '16:9';
      if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
        aspectRatio = '16:9';
      }

      // Resolution & Duration:
      // 720p supports 4s, 6s, 8s (default 4s)
      // 1080p requires 8s duration
      let resolution = (options.resolution || options.size || '720p').toLowerCase();
      if (resolution !== '720p' && resolution !== '1080p') {
        resolution = '720p';
      }

      let durationSeconds = options.duration || (resolution === '1080p' ? 8 : 4);
      if (resolution === '1080p' && durationSeconds < 8) {
        durationSeconds = 8;
      }
      if (durationSeconds < 4) durationSeconds = 4;
      if (durationSeconds > 8) durationSeconds = 8;

      const config: Record<string, unknown> = {
        aspectRatio,
        durationSeconds,
        resolution,
      };

      if (options.fps) {
        config.fps = options.fps;
      }
      if (options.seed !== undefined) {
        config.seed = options.seed;
      }
      if (options.negativePrompt) {
        config.negativePrompt = options.negativePrompt;
      }

      // Handle reference images for image-to-video
      let imageParam: { imageBytes: string; mimeType: string } | undefined;
      if (options.referenceImages?.length) {
        const refImage = options.referenceImages[0];
        const base64 = await readImageAsBase64(refImage);
        const mimeType = getMimeType(refImage);
        imageParam = {
          imageBytes: base64,
          mimeType,
        };
      }

      options.onProgress?.(`Starting video generation with ${options.model}...`);

      let operation = await this.client.models.generateVideos({
        model: modelName,
        prompt: options.prompt,
        ...(imageParam && { image: imageParam }),
        config,
      });

      // Poll until completed
      let elapsed = 0;
      const pollInterval = 5000;
      const maxWaitTime = 300000; // 5 minutes

      while (!operation.done) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        elapsed += pollInterval / 1000;
        options.onProgress?.(`Generating video with ${options.model} (elapsed: ${elapsed}s)...`);

        operation = await this.client.operations.getVideosOperation({ operation });

        if (elapsed * 1000 >= maxWaitTime) {
          return {
            success: false,
            error: `Video generation timed out after ${elapsed} seconds.`,
          };
        }
      }

      if (operation.error) {
        return {
          success: false,
          error: `Video generation failed: ${JSON.stringify(operation.error)}`,
        };
      }

      const generatedVideo = operation.response?.generatedVideos?.[0]?.video;
      if (!generatedVideo) {
        return {
          success: false,
          error: 'No video was returned by the model. Check safety filters or guidelines.',
        };
      }

      options.onProgress?.(`Downloading generated video to ${path.basename(outputPath)}...`);

      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (generatedVideo.videoBytes) {
        const buffer = Buffer.from(generatedVideo.videoBytes, 'base64');
        await Bun.write(outputPath, buffer);
      } else if (generatedVideo.uri) {
        await this.client.files.download({
          file: generatedVideo,
          downloadPath: outputPath,
        });
      } else {
        return {
          success: false,
          error: 'Video response contained neither video bytes nor download URI.',
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
          error: 'Content blocked by safety filters. Try rephrasing your video prompt.',
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

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    // Video models route directly to Veo video generation
    if (this.isVideo(options.model)) {
      return this.generateVideo(options);
    }

    // Nano-banana models default to CLI, use API only with --api flag
    if (this.isNanoBanana(options.model) && !options.useApi) {
      return this.generateViaCli(options);
    }

    // API path — require API key
    if (!this.client) {
      return {
        success: false,
        error: 'GOOGLE_API_KEY or GEMINI_API_KEY environment variable (or macOS Keychain entry) is required. For nanobanana models, omit --api to use Gemini CLI instead.',
      };
    }

    const startTime = Date.now();

    try {
      const aspectRatio = options.aspectRatio || DEFAULT_OPTIONS.aspectRatio;
      const outputPath = options.output || DEFAULT_OPTIONS.output;

      // Map model names to Gemini API model identifiers
      const modelMap: Record<string, string> = {
        'nano-banana-2': 'gemini-3.1-flash-image',
        'nano-banana-pro': 'gemini-3-pro-image',
        'nano-banana-2-lite': 'gemini-3.1-flash-lite-image',
        'nano-banana': 'gemini-2.5-flash-image',
      };
      const modelName = modelMap[options.model] || 'gemini-3.1-flash-image';

      // Determine image size based on model and size/resolution option
      let imageSize: string | undefined;
      const rawSize = options.resolution || options.size;
      if (rawSize) {
        const sizeUpper = rawSize.toUpperCase();
        if (['1K', '2K', '4K'].includes(sizeUpper)) {
          // nano-banana-2-lite is optimized for 1K
          if (options.model === 'nano-banana-2-lite' && sizeUpper !== '1K') {
            imageSize = '1K';
          } else {
            imageSize = sizeUpper;
          }
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
