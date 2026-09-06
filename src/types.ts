export type Provider = 'replicate' | 'openai' | 'google';

export type Model =
  | 'flux'
  | 'flux-schnell'
  | 'flux-pro'
  | 'gpt-image-1'
  | 'gpt-image-1-mini'
  | 'gpt-image-1.5'
  | 'gpt-image-2'
  // Google Gemini Image Models (Nano Banana family)
  | 'nano-banana-2'
  | 'nano-banana-pro'
  | 'nano-banana-2-lite'
  | 'nano-banana'
  // Google Gemini Video Models (Veo family)
  | 'veo-3.1'
  | 'veo-3.1-lite';

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
  resolution?: string;
  duration?: number;
  fps?: number;
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
  onProgress?: (status: string) => void;
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
  'gpt-image-1-mini': 'openai',
  'gpt-image-1.5': 'openai',
  'gpt-image-2': 'openai',
  'nano-banana-2': 'google',
  'nano-banana-pro': 'google',
  'nano-banana-2-lite': 'google',
  'nano-banana': 'google',
  'veo-3.1': 'google',
  'veo-3.1-lite': 'google',
};

export const MODEL_ALIASES: Record<string, Model> = {
  'gemini-3.1-flash-image': 'nano-banana-2',
  'gemini-3.1-flash': 'nano-banana-2',
  'gemini-flash': 'nano-banana-2',
  'gemini-3-pro-image': 'nano-banana-pro',
  'gemini-3-pro': 'nano-banana-pro',
  'gemini-pro': 'nano-banana-pro',
  'gemini-3.1-flash-lite-image': 'nano-banana-2-lite',
  'gemini-3.1-flash-lite': 'nano-banana-2-lite',
  'gemini-lite': 'nano-banana-2-lite',
  'nano-banana-lite': 'nano-banana-2-lite',
  'gemini-2.5-flash-image': 'nano-banana',
  'gemini-2.5-flash': 'nano-banana',
  'veo': 'veo-3.1',
  'veo-3.1-generate-preview': 'veo-3.1',
  'veo-lite': 'veo-3.1-lite',
  'veo-3.1-lite-generate-preview': 'veo-3.1-lite',
};

export const OBSOLETE_MODELS: Record<string, { replacement: Model; reason: string }> = {
  'imagen-3': {
    replacement: 'nano-banana-2',
    reason: 'Imagen 3 was retired by Google on August 17, 2026. Use nano-banana-2 (Gemini 3.1 Flash Image) instead.',
  },
  'imagen-3-fast': {
    replacement: 'nano-banana-2-lite',
    reason: 'Imagen 3 Fast was retired by Google on August 17, 2026. Use nano-banana-2-lite (Gemini 3.1 Flash Lite Image) instead.',
  },
  'imagen-4': {
    replacement: 'nano-banana-pro',
    reason: 'Imagen 4 was retired by Google on August 17, 2026. Use nano-banana-pro (Gemini 3 Pro Image) instead.',
  },
  'imagen-3.0-generate-002': {
    replacement: 'nano-banana-2',
    reason: 'Imagen 3 was retired by Google on August 17, 2026. Use nano-banana-2 (Gemini 3.1 Flash Image) instead.',
  },
  'imagen-3.0-fast-generate-001': {
    replacement: 'nano-banana-2-lite',
    reason: 'Imagen 3 Fast was retired by Google on August 17, 2026. Use nano-banana-2-lite (Gemini 3.1 Flash Lite Image) instead.',
  },
  'veo-2': {
    replacement: 'veo-3.1',
    reason: 'Veo 2.0 was retired by Google on June 30, 2026. Use veo-3.1 instead.',
  },
  'veo-2.0': {
    replacement: 'veo-3.1',
    reason: 'Veo 2.0 was retired by Google on June 30, 2026. Use veo-3.1 instead.',
  },
  'veo-2.0-generate-001': {
    replacement: 'veo-3.1',
    reason: 'Veo 2.0 was retired by Google on June 30, 2026. Use veo-3.1 instead.',
  },
};

export function isVideoModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith('veo');
}

export function resolveModel(modelName: string): Model {
  const lower = modelName.toLowerCase();
  if (lower in MODEL_TO_PROVIDER) {
    return lower as Model;
  }
  if (lower in MODEL_ALIASES) {
    return MODEL_ALIASES[lower];
  }
  if (lower in OBSOLETE_MODELS) {
    const obs = OBSOLETE_MODELS[lower];
    throw new Error(`Model "${modelName}" is obsolete: ${obs.reason}`);
  }
  return modelName as Model;
}

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
  model: 'nano-banana-2' as Model,
  aspectRatio: '16:9' as AspectRatio,
  output: '/tmp/generated-image.png',
  videoOutput: '/tmp/generated-video.mp4',
  quality: 'standard' as const,
  style: 'vivid' as const,
  numImages: 1,
  steps: 28,
  guidance: 3.5,
  duration: 4,
  resolution: '720p',
};
