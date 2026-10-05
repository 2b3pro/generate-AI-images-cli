import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base';
import { AtlasClient, describeAtlasError } from './atlas-client';
import type { GenerateOptions, GenerationResult, JobRecord, Model, ModelSpec, RequestRecord, RoleRef } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { getModelSpec, modelsForProvider } from '../config/models';
import { renderRefLabels } from '../refs';
import { resolveApiKey } from '../utils/keychain';
import { extFor, outputPathFor } from '../utils/download';
import { DEFAULT_WAIT_SECONDS, POLL_INTERVAL_MS, updateJob, waitForJob, writeJob } from '../utils/jobs';

type UploadedRef = RoleRef & { url: string };

/** Pure: map CLI options onto one Atlas request body. Throws when the spec cannot express the request. */
export function buildAtlasRequest(
  spec: ModelSpec,
  options: GenerateOptions,
  uploaded: { legacy: string[]; refs: UploadedRef[] }
): { modelId: string; body: Record<string, unknown>; promptSent: string } {
  const inputs = spec.inputs ?? {};
  const where = `${spec.name} (atlas)`;
  const start = uploaded.refs.find((r) => r.role === 'start');
  const end = uploaded.refs.find((r) => r.role === 'end');
  const others = uploaded.refs.filter((r) => r.role !== 'start' && r.role !== 'end');

  let modelId = spec.id;
  if (spec.kind === 'image' && (others.length > 0 || uploaded.legacy.length > 0)) {
    if (!spec.edit_id) throw new Error(`${where} has no edit variant for reference images`);
    modelId = spec.edit_id;
  }
  if (spec.kind === 'video') {
    if (start || uploaded.legacy.length > 0) {
      if (!spec.i2v_id) throw new Error(`${where} has no image-to-video variant`);
      modelId = spec.i2v_id;
    } else if (others.length > 0) {
      if (!spec.r2v_id) throw new Error(`${where} has no reference-to-video variant`);
      modelId = spec.r2v_id;
    }
  }

  let promptSent = options.prompt;
  const labels = renderRefLabels(spec.label_style, others);
  if (labels) promptSent += `\n\n${labels}`;
  if (options.negativePrompt && !inputs.negative_prompt) promptSent += `\n\nAvoid: ${options.negativePrompt}`;

  const body: Record<string, unknown> = { model: modelId, [inputs.prompt ?? 'prompt']: promptSent };
  if (options.negativePrompt && inputs.negative_prompt) body[inputs.negative_prompt] = options.negativePrompt;
  if (inputs.aspect_ratio && options.aspectRatio) body[inputs.aspect_ratio] = options.aspectRatio;
  const size = options.resolution ?? options.size;
  if (inputs.resolution && size) {
    body[inputs.resolution] = inputs.resolution_values?.[size] ?? inputs.resolution_values?.[size.toUpperCase()] ?? size;
  }
  if (inputs.duration && options.duration !== undefined) body[inputs.duration] = options.duration;
  if (inputs.seed && options.seed !== undefined) body[inputs.seed] = options.seed;

  const frame = start?.url ?? (spec.kind === 'video' ? uploaded.legacy[0] : undefined);
  if (frame) {
    if (!inputs.image) throw new Error(`${where} has no start-frame field configured`);
    body[inputs.image] = frame;
  }
  if (end) {
    if (!inputs.end_image) throw new Error(`${where} has no end-frame field configured`);
    body[inputs.end_image] = end.url;
  }

  const imageList = [...others.map((r) => r.url), ...(spec.kind === 'image' ? uploaded.legacy : [])];
  if (imageList.length > 0) {
    if (inputs.images) body[inputs.images] = imageList.slice(0, inputs.max_images ?? imageList.length);
    else if (inputs.image && spec.kind === 'image') body[inputs.image] = imageList[0];
    else throw new Error(`${where} has no reference-image field configured`);
  }

  for (const [k, v] of Object.entries(options.params ?? {})) body[k] = v;
  return { modelId, body, promptSent };
}

function defaultClient(): AtlasClient {
  const key = resolveApiKey(['ATLASCLOUD_API_KEY']);
  if (!key) throw new Error('ATLASCLOUD_API_KEY environment variable (or macOS Keychain entry) is required for Atlas models');
  return new AtlasClient(key);
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

export class AtlasProvider extends BaseProvider {
  name = 'Atlas';
  models: Model[] = modelsForProvider('atlas');
  private uploads = new Map<string, string>();
  private client: AtlasClient;

  constructor(client?: AtlasClient) {
    super();
    this.client = client ?? defaultClient();
  }

  private async urlFor(source: string): Promise<string> {
    if (isUrl(source)) return source;
    const abs = fs.realpathSync(source);
    const cached = this.uploads.get(abs);
    if (cached) return cached;
    const url = await this.client.upload(abs);
    this.uploads.set(abs, url);
    return url;
  }

  private async prepare(options: GenerateOptions) {
    const spec = getModelSpec(options.model, 'atlas');
    const legacy = await Promise.all((options.referenceImages ?? []).map((p) => this.urlFor(p)));
    const refs: UploadedRef[] = [];
    for (const r of options.refs ?? []) refs.push({ ...r, url: await this.urlFor(r.source) });
    const built = buildAtlasRequest(spec, options, { legacy, refs });
    const { model: _model, ...params } = built.body;
    const request: RequestRecord = {
      prompt_sent: built.promptSent,
      seed: options.seed,
      params,
      refs: [
        ...(options.referenceImages ?? []).map((p, i) => ({ role: 'reference' as const, path: p, uploaded_url: legacy[i] })),
        ...refs.map((r) => ({ role: r.role, path: r.source, uploaded_url: r.url, note: r.note })),
      ],
      draft: Boolean(options.draft),
    };
    return { spec, ...built, request };
  }

  async quote(options: GenerateOptions): Promise<number> {
    const { body } = await this.prepare(options);
    return this.client.calculate(body);
  }

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    let prepared;
    try {
      prepared = await this.prepare(options);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
    const { spec, body, modelId, request } = prepared;
    const output =
      options.output ?? (spec.kind === 'video' ? DEFAULT_OPTIONS.videoOutput : spec.kind === 'audio' ? DEFAULT_OPTIONS.audioOutput : DEFAULT_OPTIONS.output);

    let id: string;
    try {
      id = await this.client.submit(spec.kind, body);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    const record: JobRecord = {
      id,
      provider: 'atlas',
      model: spec.name,
      kind: spec.kind,
      output,
      submittedAt: new Date().toISOString(),
      status: 'pending',
      provider_model_id: modelId,
      request,
    };
    writeJob(record);
    if (options.noWait) return { success: false, pending: true, jobId: id, providerModelId: modelId, request };
    return this.finish(record, options);
  }

  async resume(record: JobRecord, opts: { waitSeconds?: number; onProgress?: (status: string) => void }): Promise<GenerationResult> {
    return this.finish(record, opts);
  }

  private async finish(record: JobRecord, opts: { waitSeconds?: number; onProgress?: (status: string) => void }): Promise<GenerationResult> {
    const base = { jobId: record.id, providerModelId: record.provider_model_id, request: record.request };
    const state = await waitForJob(() => this.client.poll(record.id), {
      waitSeconds: opts.waitSeconds ?? DEFAULT_WAIT_SECONDS[record.kind],
      intervalMs: POLL_INTERVAL_MS[record.kind],
      onProgress: opts.onProgress,
    });

    if (state.status === 'timeout') {
      return { ...base, success: false, pending: true, error: `Still running. Resume with: generate --resume ${record.id}` };
    }
    if (state.status === 'failed') {
      const message = describeAtlasError(state.code, state.message);
      updateJob(record.id, { status: 'failed', error: { code: state.code, message } });
      return { ...base, success: false, error: message, errorCode: state.code };
    }
    if (state.status !== 'completed') {
      return { ...base, success: false, error: `Unexpected job state ${state.status}` };
    }

    const outputs: string[] = [];
    for (const [i, url] of state.urls.entries()) {
      const { bytes, contentType } = await this.client.fetchBytes(url);
      const target = outputPathFor(record.output, i, state.urls.length, extFor(url, contentType));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await Bun.write(target, bytes);
      outputs.push(target);
    }
    if (outputs.length === 0) {
      updateJob(record.id, { status: 'failed', error: { message: 'completed with no outputs' } });
      return { ...base, success: false, error: 'Atlas reported completion but returned no outputs' };
    }
    if (outputs[0] !== record.output) opts.onProgress?.(`Saved as ${path.basename(outputs[0])} (the provider served a different file type)`);
    updateJob(record.id, { status: 'completed', outputs });
    return { ...base, success: true, outputPath: outputs[0], outputs };
  }
}
