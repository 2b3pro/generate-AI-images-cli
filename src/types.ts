export type Provider = 'replicate' | 'openai' | 'google' | 'atlas' | 'codex' | 'agy';

/**
 * Canonical model name as listed in config/models/*.yaml (e.g. "nano-banana-2",
 * "gpt-image-2.5-sunburst"). The registry in src/config/models.ts is the
 * source of truth; nothing in code enumerates models any more.
 */
export type Model = string;

export type ModelKind = 'image' | 'video' | 'audio';

/** metered = charged per call; plan = draws on a subscription's usage limits */
export type Billing = 'metered' | 'plan';

export type RefRole = 'start' | 'end' | 'identity' | 'style' | 'object' | 'location';
export const REF_ROLES: RefRole[] = ['start', 'end', 'identity', 'style', 'object', 'location'];

/** How references are named inside the prompt sent to the model */
export type LabelStyle = 'prose' | 'at-index' | 'wan-numbered';

export interface RoleRef {
  role: RefRole;
  /** Local path or http(s) URL */
  source: string;
  note?: string;
}

/** Per-model reference rules. A role that is absent or 0 is not accepted. */
export type RefCaps = Partial<Record<RefRole, number>> & {
  exclusive?: RefRole[][];
  forces?: Partial<Record<RefRole, { duration?: number }>>;
  max_people_warning?: number;
};

export interface DirectPrice {
  usd: number;
  /** "image", "second", or "plan limits" */
  unit: string;
  source?: string;
  checked?: string;
}

export interface DraftTier {
  model?: Model;
  resolution?: string;
}

/** Atlas: request field names for CLI options. Omitted = the model has no such field. */
export interface AtlasInputs {
  /** Field that carries the prompt text (default "prompt"; TTS models often use "text") */
  prompt?: string;
  end_image?: string;
  duration?: string;
  aspect_ratio?: string;
  seed?: string;
  negative_prompt?: string;
}

export interface RequestRecord {
  prompt_sent: string;
  seed?: number;
  params: Record<string, unknown>;
  refs: { role: RefRole | 'reference'; path: string; uploaded_url?: string; note?: string }[];
  draft: boolean;
}

export type JobStatus = 'pending' | 'completed' | 'failed';

export interface JobRecord {
  /** Provider's remote id: Atlas prediction id or Veo operation name */
  id: string;
  provider: Provider;
  model: Model;
  kind: ModelKind;
  output: string;
  submittedAt: string;
  status: JobStatus;
  provider_model_id?: string;
  quote?: { usd: number };
  outputs?: string[];
  error?: { code?: number | string; message: string };
  request?: RequestRecord;
}

/** One entry from a provider's YAML file, normalised by the registry loader. */
export interface ModelSpec {
  /** Canonical CLI name (the YAML key) */
  name: Model;
  provider: Provider;
  /** Identifier sent to the provider's API (defaults to `name`) */
  id: string;
  kind: ModelKind;
  description?: string;
  /** Alternate names accepted by --model */
  aliases: string[];
  /** Human-readable deprecation notice; the CLI warns when the model is used */
  deprecated?: string;
  /** How this path is paid for; required in every YAML entry */
  billing: Billing;
  /** Backend inspects and may revise its own output (Codex, Antigravity) */
  agentic?: boolean;
  /** Atlas: model id used when reference images are given to an image model */
  edit_id?: string;
  /** Atlas: model id used for image-to-video (a start frame is given) */
  i2v_id?: string;
  /** Atlas: model id used for reference-to-video (identity/style/object/location refs, no start frame) */
  r2v_id?: string;
  refs?: RefCaps;
  label_style?: LabelStyle;
  draft?: DraftTier;
  direct_price?: DirectPrice;
  /** Codex: agent model passed as --model; omitted = Codex's configured default */
  agent_model?: string;
  /** Codex/Antigravity: reasoning effort */
  reasoning_effort?: string;
  /** Agent providers: process timeout in seconds (default 600) */
  timeout_seconds?: number;

  // ---- Provider-specific capability flags (all optional) ----
  /** OpenAI: model accepts reference images via the images.edit endpoint */
  edit?: boolean;
  /** OpenAI: "fixed" = only `sizes` are legal; "flexible" = any WxH divisible by 16 */
  size_mode?: 'fixed' | 'flexible';
  /** OpenAI: legal size strings when size_mode is "fixed" */
  sizes?: string[];
  /** OpenAI: longest-edge limit in pixels when size_mode is "flexible" */
  max_edge?: number;
  /** OpenAI: minimum width*height when size_mode is "flexible" */
  min_pixels?: number;
  /** OpenAI: maximum width*height when size_mode is "flexible" */
  max_pixels?: number;
  /** OpenAI: quality values the model accepts; the CLI's standard/hd map onto these */
  qualities?: string[];
  /** Google image: imageSize values the model accepts (e.g. 512, 1K, 2K, 4K); omit if the model has no size control */
  image_sizes?: (string | number)[];
  /** Google video: resolutions the model accepts (e.g. 720p, 1080p, 4k); first entry is the default */
  resolutions?: string[];
  /** Replicate: aspect_ratio enum the model accepts; others are rejected before the API call */
  aspect_ratios?: string[];
  /** Replicate: how CLI options map onto this model's input schema */
  inputs?: ReplicateInputs & AtlasInputs;
}

/**
 * Replicate models differ in which input fields they accept. Each entry names
 * the schema field to use for a CLI option, or is omitted when the model has
 * no such field (the option is then ignored).
 */
export interface ReplicateInputs {
  /** Field that takes an ARRAY of reference image URLs (e.g. input_images, images) */
  images?: string;
  /** Field that takes a SINGLE reference image URL (e.g. image, image_prompt, input_image) */
  image?: string;
  /** Max reference images for the `images` field */
  max_images?: number;
  /** Send prompt_strength alongside `image` (true img2img models only) */
  prompt_strength?: boolean;
  /** Field for --steps (steps | num_inference_steps) */
  steps?: string;
  /** Field for --guidance (guidance) */
  guidance?: string;
  /** Model accepts output_quality (0-100) */
  output_quality?: boolean;
  /** Model accepts num_outputs */
  num_outputs?: boolean;
  /** Field for output resolution (resolution | megapixels | output_megapixels) */
  resolution?: string;
  /** Map from CLI size preset (512/1K/2K/4K) to this model's resolution enum value */
  resolution_values?: Record<string, string>;
}

export interface ObsoleteModel {
  replacement: Model;
  reason: string;
}

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
  quality?: 'standard' | 'hd' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  style?: 'vivid' | 'natural';
  numImages?: number;
  /** Role-typed references (--ref) */
  refs?: RoleRef[];
  /** Model-specific top-level request fields (--param) */
  params?: Record<string, unknown>;
  /** Poll deadline override in seconds (--wait) */
  waitSeconds?: number;
  /** Submit and return without polling (--no-wait) */
  noWait?: boolean;
  /** Request is running on a draft tier */
  draft?: boolean;
  /** @deprecated No-op since 2026-09-06 — the Gemini API is the only image
   *  route. Kept so existing callers passing --api do not break. */
  useApi?: boolean;
  onProgress?: (status: string) => void;
}

export interface GenerationResult {
  success: boolean;
  outputPath?: string;
  /** All written files (multi-output providers); falls back to [outputPath] */
  outputs?: string[];
  error?: string;
  errorCode?: number | string;
  /** Async job still running (timed out or --no-wait) */
  pending?: boolean;
  jobId?: string;
  providerModelId?: string;
  request?: RequestRecord;
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
  /** Continue a recorded async job */
  resume?(record: JobRecord, options: { waitSeconds?: number; onProgress?: (status: string) => void }): Promise<GenerationResult>;
  /** Price a request without running it */
  quote?(options: GenerateOptions): Promise<{ usd: number; providerModelId?: string }>;
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
  audioOutput: '/tmp/generated-audio.mp3',
  quality: 'standard' as const,
  style: 'vivid' as const,
  numImages: 1,
  steps: 28,
  guidance: 3.5,
  duration: 4,
  resolution: '720p',
};
