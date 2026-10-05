import { GenerateVideosOperation, GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, JobRecord, Model } from '../types';
import { DEFAULT_WAIT_SECONDS, POLL_INTERVAL_MS, RetryableError, updateJob, waitForJob, writeJob, type PollState } from '../utils/jobs';
import { DEFAULT_OPTIONS } from '../types';
import { getModelSpec, modelsForProvider } from '../config/models';
import { readImageAsBase64, getMimeType } from '../utils/download';
import { getKeychainPassword } from '../utils/keychain';

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

export function veoPollState(op: { done?: boolean; error?: Record<string, unknown> }): PollState {
  if (!op.done) return { status: 'processing' };
  if (op.error) return { status: 'failed', message: JSON.stringify(op.error) };
  return { status: 'completed', urls: [] };
}

export class GoogleProvider extends BaseProvider {
  name = 'Google';
  // Model list, Gemini API ids, and capability flags live in config/models/google.yaml
  models: Model[] = modelsForProvider('google');

  private client: GoogleGenAI | null = null;

  constructor(client?: GoogleGenAI) {
    super();
    if (client) {
      this.client = client;
      return;
    }
    const apiKey = resolveApiKey();
    if (apiKey) {
      // Ensure vertexai: false when using Gemini API keys
      delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
      delete process.env.GOOGLE_CLOUD_PROJECT;

      // @google/genai reads GOOGLE_API_KEY / GEMINI_API_KEY from the ambient
      // environment and PREFERS GOOGLE_API_KEY over the key passed here
      // ("Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using
      // GOOGLE_API_KEY."). Since this binary's shebang is `bun`, Bun auto-loads
      // a .env from whatever directory the user happens to be in, so a stale
      // GOOGLE_API_KEY sitting in some project's .env silently overrode the key
      // we just resolved — making generation fail with API_KEY_INVALID in one
      // directory and succeed in another (diagnosed 2026-09-06).
      //
      // resolveApiKey() has ALREADY read these vars at their correct priority,
      // so clearing them now loses nothing and makes the resolved key
      // authoritative regardless of cwd.
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;

      this.client = new GoogleGenAI({ apiKey, vertexai: false });
    }
  }

  private isVideo(model: Model): boolean {
    return getModelSpec(model, 'google').kind === 'video';
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
      const spec = getModelSpec(options.model, 'google');
      const modelName = spec.id;

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

      // Resolution & Duration (resolutions list comes from YAML; first entry is default):
      // 720p supports 4s, 6s, 8s; 1080p and 4k require 8s.
      const allowedRes = (spec.resolutions ?? ['720p', '1080p']).map((r) => r.toLowerCase());
      let resolution = (options.resolution || options.size || allowedRes[0]).toLowerCase();
      if (!allowedRes.includes(resolution)) {
        resolution = allowedRes[0];
      }

      let durationSeconds = options.duration || (resolution === '720p' ? 4 : 8);
      if (resolution !== '720p' && durationSeconds < 8) {
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

      const operation = await this.client.models.generateVideos({
        model: modelName,
        prompt: options.prompt,
        ...(imageParam && { image: imageParam }),
        config,
      });

      if (!operation.name) {
        return { success: false, error: 'Veo returned no operation name, so the job cannot be tracked. Check the Google AI Studio dashboard before retrying.' };
      }
      const record: JobRecord = {
        id: operation.name,
        provider: 'google',
        model: options.model,
        kind: 'video',
        output: outputPath,
        submittedAt: new Date().toISOString(),
        status: 'pending',
        provider_model_id: modelName,
        request: {
          prompt_sent: options.prompt,
          seed: options.seed,
          params: config,
          refs: (options.referenceImages ?? []).slice(0, 1).map((p) => ({ role: 'start' as const, path: p })),
          draft: Boolean(options.draft),
        },
      };
      writeJob(record);
      if (options.noWait) return { success: false, pending: true, jobId: record.id, providerModelId: modelName, request: record.request };
      return await this.waitVeo(operation, record, options);
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

  private async waitVeo(
    initial: GenerateVideosOperation,
    record: JobRecord,
    opts: { waitSeconds?: number; onProgress?: (status: string) => void }
  ): Promise<GenerationResult> {
    let current = initial;
    const state = await waitForJob(
      async () => {
        try {
          current = await this.client!.operations.getVideosOperation({ operation: current });
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 429 || (status !== undefined && status >= 500)) throw new RetryableError(`HTTP ${status}`);
          throw err;
        }
        return veoPollState(current);
      },
      { waitSeconds: opts.waitSeconds ?? DEFAULT_WAIT_SECONDS.video, intervalMs: POLL_INTERVAL_MS.video, onProgress: opts.onProgress }
    );

    if (state.status === 'timeout') {
      return { success: false, pending: true, jobId: record.id, providerModelId: record.provider_model_id, request: record.request, error: `Still running. Resume with: generate --resume ${record.id}` };
    }
    if (state.status === 'failed') {
      updateJob(record.id, { status: 'failed', error: { message: state.message } });
      return { success: false, jobId: record.id, error: `Video generation failed: ${state.message}` };
    }
    const saved = await this.saveVeoVideo(current, record.output, opts.onProgress);
    if (!saved.success) {
      updateJob(record.id, { status: 'failed', error: { message: saved.error ?? 'download failed' } });
      return { ...saved, jobId: record.id };
    }
    updateJob(record.id, { status: 'completed', outputs: [record.output] });
    return { success: true, outputPath: record.output, outputs: [record.output], jobId: record.id, providerModelId: record.provider_model_id, request: record.request };
  }

  private async saveVeoVideo(op: GenerateVideosOperation, outputPath: string, onProgress?: (s: string) => void): Promise<GenerationResult> {
    const generatedVideo = op.response?.generatedVideos?.[0]?.video;
    if (!generatedVideo) {
      return { success: false, error: 'No video was returned by the model. Check safety filters or guidelines.' };
    }
    onProgress?.(`Downloading generated video to ${path.basename(outputPath)}...`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (generatedVideo.videoBytes) {
      await Bun.write(outputPath, Buffer.from(generatedVideo.videoBytes, 'base64'));
    } else if (generatedVideo.uri) {
      await this.client!.files.download({ file: generatedVideo, downloadPath: outputPath });
    } else {
      return { success: false, error: 'Video response contained neither video bytes nor download URI.' };
    }
    return { success: true, outputPath };
  }

  async resume(record: JobRecord, opts: { waitSeconds?: number; onProgress?: (status: string) => void }): Promise<GenerationResult> {
    if (!this.client) {
      return { success: false, error: 'GOOGLE_API_KEY or GEMINI_API_KEY (or a macOS Keychain entry) is required to resume a Veo job.' };
    }
    const op = new GenerateVideosOperation();
    op.name = record.id;
    return this.waitVeo(op, record, opts);
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    // Video models route directly to Veo video generation
    if (this.isVideo(options.model)) {
      return this.generateVideo(options);
    }

    // All image models go through the Gemini API. The former `gemini` CLI route
    // was removed 2026-09-06: that CLI is deprecated and now fails at auth
    // ("This client is no longer supported for Gemini Code Assist for
    // individuals"), and it identified its output by regex-scraping a file path
    // out of agent prose, which was never a reliable contract.
    if (!this.client) {
      return {
        success: false,
        error:
          'No Gemini API key found. Set GEMINI_API_KEY (or GOOGLE_API_KEY / NANOBANANA_API_KEY), ' +
          'or add one to the macOS Keychain:\n' +
          '  security add-generic-password -a "$USER" -s "gemini-api-key" -w "<your key>"',
      };
    }

    const startTime = Date.now();

    try {
      const aspectRatio = options.aspectRatio || DEFAULT_OPTIONS.aspectRatio;
      const outputPath = options.output || DEFAULT_OPTIONS.output;

      const spec = getModelSpec(options.model, 'google');
      const modelName = spec.id;

      // Determine image size from the model's allowed list (image_sizes in YAML).
      // Requests above the model's ceiling fall back to the largest allowed size.
      let imageSize: string | undefined;
      const rawSize = options.resolution || options.size;
      const allowedSizes = (spec.image_sizes ?? []).map((v) => String(v).toUpperCase());
      if (rawSize && allowedSizes.length) {
        const order = ['512', '1K', '2K', '4K'];
        const want = rawSize.toUpperCase();
        if (order.includes(want)) {
          const notAbove = allowedSizes
            .filter((a) => order.indexOf(a) <= order.indexOf(want))
            .sort((a, b) => order.indexOf(b) - order.indexOf(a));
          imageSize = notAbove[0] ?? allowedSizes[0];
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
