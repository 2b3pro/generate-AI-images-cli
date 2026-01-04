import { GoogleGenAI } from '@google/genai';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model, AspectRatio } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { readImageAsBase64, getMimeType } from '../utils/download';

export class GoogleProvider extends BaseProvider {
  name = 'Google';
  models: Model[] = ['imagen-3', 'imagen-3-fast', 'imagen-4', 'nano-banana', 'nano-banana-pro'];

  private client: GoogleGenAI;

  constructor() {
    super();
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY environment variable is required');
    }
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
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
