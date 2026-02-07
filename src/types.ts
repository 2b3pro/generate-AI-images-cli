export type Provider = 'replicate' | 'openai' | 'google';

export type Model =
  | 'flux'
  | 'flux-schnell'
  | 'flux-pro'
  | 'gpt-image-1'
  | 'gpt-image-1.5'
  | 'imagen-3'
  | 'imagen-3-fast'
  | 'imagen-4'
  | 'nano-banana'
  | 'nano-banana-pro';

export type AspectRatio =
  | '1:1' | '16:9' | '9:16'
  | '4:3' | '3:4' | '3:2' | '2:3'
  | '4:5' | '5:4' | '21:9';

export type OpenAISize = '1024x1024' | '1024x1792' | '1792x1024' | '1536x1536' | '1024x1536' | '1536x1024';

export type GoogleResolution = '1K' | '2K' | '4K';

export interface GenerateOptions {
  model: Model;
  prompt: string;
  size?: string;
  aspectRatio?: AspectRatio;
  output?: string;
  referenceImages?: string[];
  transparent?: boolean;
  removeBg?: boolean;
  addBg?: string;
  negativePrompt?: string;
  thumbnail?: number | boolean;
  variations?: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
  numImages?: number;
  useApi?: boolean;
}

export interface GenerationResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  metadata?: {
    model: string;
    prompt: string;
    seed?: number;
    duration?: number;
  };
}

export interface ImageProvider {
  name: string;
  models: Model[];
  generate(options: GenerateOptions): Promise<GenerationResult>;
}

export const MODEL_TO_PROVIDER: Record<Model, Provider> = {
  'flux': 'replicate',
  'flux-schnell': 'replicate',
  'flux-pro': 'replicate',
  'gpt-image-1': 'openai',
  'gpt-image-1.5': 'openai',
  'imagen-3': 'google',
  'imagen-3-fast': 'google',
  'imagen-4': 'google',
  'nano-banana': 'google',
  'nano-banana-pro': 'google',
};

export const ASPECT_RATIO_TO_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '4:3': { width: 1152, height: 896 },
  '3:4': { width: 896, height: 1152 },
  '3:2': { width: 1216, height: 832 },
  '2:3': { width: 832, height: 1216 },
  '4:5': { width: 896, height: 1088 },
  '5:4': { width: 1088, height: 896 },
  '21:9': { width: 1536, height: 640 },
};

export const DEFAULT_OPTIONS = {
  model: 'nano-banana-pro' as Model,
  aspectRatio: '16:9' as AspectRatio,
  output: '/tmp/generated-image.png',
  quality: 'standard' as const,
  style: 'vivid' as const,
  numImages: 1,
  steps: 28,
  guidance: 3.5,
};
