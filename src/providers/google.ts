import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, Part } from '@google/generative-ai';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model, AspectRatio, GoogleResolution } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { readImageAsBase64, getMimeType } from '../utils/download';

const RESOLUTION_TO_PIXELS: Record<GoogleResolution, number> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
};

export class GoogleProvider extends BaseProvider {
  name = 'Google';
  models: Model[] = ['imagen-3', 'imagen-3-fast', 'imagen-4', 'nano-banana', 'nano-banana-pro'];

  private client: GoogleGenerativeAI;

  constructor() {
    super();
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY environment variable is required');
    }
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const startTime = Date.now();

    try {
      const aspectRatio = options.aspectRatio || DEFAULT_OPTIONS.aspectRatio;
      const outputPath = options.output || DEFAULT_OPTIONS.output;

      // Determine resolution based on size parameter
      let resolution: GoogleResolution = '2K';
      if (options.size) {
        if (options.size.toUpperCase() in RESOLUTION_TO_PIXELS) {
          resolution = options.size.toUpperCase() as GoogleResolution;
        }
      }

      // Map model names to Gemini API model identifiers
      const modelMap: Record<string, string> = {
        'imagen-3': 'imagen-3.0-generate-002',
        'imagen-3-fast': 'imagen-3.0-fast-generate-001',
        'imagen-4': 'imagen-4.0-generate-preview-05-20',
        'nano-banana': 'gemini-2.0-flash-exp', // Gemini image generation
        'nano-banana-pro': 'gemini-2.0-flash-exp', // Gemini image generation (pro features)
      };
      const modelName = modelMap[options.model] || 'gemini-2.0-flash-exp';

      // Create the model for image generation with config cast to any for Imagen support
      const model = this.client.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'image/png',
        } as Record<string, unknown>,
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
        ],
      });

      // Build the prompt with aspect ratio hint
      let enhancedPrompt = options.prompt;

      // Add negative prompt if provided
      if (options.negativePrompt) {
        enhancedPrompt += ` Avoid: ${options.negativePrompt}`;
      }

      // Build content parts - supports multiple reference images
      const parts: Part[] = [];

      // Add reference images first (for style/composition guidance)
      if (options.referenceImages?.length) {
        for (const imagePath of options.referenceImages) {
          const base64 = await readImageAsBase64(imagePath);
          const mimeType = getMimeType(imagePath) as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
          parts.push({
            inlineData: {
              mimeType,
              data: base64,
            },
          });
        }
      }

      // Add text prompt
      parts.push({ text: enhancedPrompt });

      const result = await model.generateContent(parts);

      const response = result.response;
      const candidate = response.candidates?.[0];

      if (!candidate || !candidate.content?.parts?.[0]) {
        return {
          success: false,
          error: 'No image generated - check if the prompt was blocked',
        };
      }

      const part = candidate.content.parts[0] as { inlineData?: { data?: string } };

      if (part.inlineData?.data) {
        await this.saveBase64Image(part.inlineData.data, outputPath);
      } else {
        return {
          success: false,
          error: 'Unexpected response format from Google API',
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

      // Check for common Google API errors
      if (errorMessage.includes('SAFETY')) {
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
