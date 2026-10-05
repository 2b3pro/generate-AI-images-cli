import path from 'path';
import type { Billing, GenerateOptions, GenerationResult, ImageProvider, ModelSpec, Provider, RequestRecord } from './types';
import { resolveModel, selectSpec, type BillingFilter } from './config/models';
import { validateRefs } from './refs';
import { priceFor } from './cost';
import { readJob } from './utils/jobs';

export type ExitCode = 0 | 1 | 2 | 75;

export interface ResultJson {
  ok: boolean;
  provider: Provider | null;
  model: string | null;
  provider_model_id: string | null;
  outputs: string[];
  job_id: string | null;
  quote_usd: number | null;
  billing: Billing | null;
  agentic: boolean;
  request: RequestRecord | null;
  error: string | null;
  exit_code: ExitCode;
  pending?: boolean;
  warnings: string[];
}

export interface RunRequest {
  modelInput: string;
  via?: Provider;
  billing: BillingFilter;
  draft: boolean;
  quoteOnly: boolean;
  maxCost?: number;
  options: Omit<GenerateOptions, 'model'>;
}

export interface RunDeps {
  getProvider: (provider: Provider) => ImageProvider;
  stamp?: (paths: string[], json: ResultJson) => Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function emptyResult(): ResultJson {
  return { ok: false, provider: null, model: null, provider_model_id: null, outputs: [], job_id: null, quote_usd: null, billing: null, agentic: false, request: null, error: null, exit_code: 1, warnings: [] };
}

function fail(json: ResultJson, code: ExitCode, error: string): ResultJson {
  return { ...json, ok: false, exit_code: code, error };
}

export function draftPath(output: string): string {
  const ext = path.extname(output);
  return ext ? `${output.slice(0, -ext.length)}.draft${ext}` : `${output}.draft`;
}

export async function run(req: RunRequest, deps: RunDeps): Promise<ResultJson> {
  let json = emptyResult();

  let name: string;
  try {
    name = resolveModel(req.modelInput);
  } catch (err) {
    return fail(json, 1, message(err));
  }

  let spec: ModelSpec;
  try {
    spec = selectSpec(name, { via: req.via, billing: req.billing });
  } catch (err) {
    return fail(json, 2, message(err));
  }

  const options: GenerateOptions = { ...req.options, model: spec.name };
  if (req.draft) {
    const tier = spec.draft;
    if (!tier) return fail(json, 2, `${spec.name} (${spec.provider}) has no draft tier`);
    if (tier.model) {
      try {
        spec = selectSpec(resolveModel(tier.model), { billing: req.billing });
      } catch (err) {
        return fail(json, 2, message(err));
      }
      options.model = spec.name;
    }
    if (tier.resolution) options.resolution = tier.resolution;
    if (options.output) options.output = draftPath(options.output);
    options.draft = true;
  }

  json = { ...json, provider: spec.provider, model: spec.name, provider_model_id: spec.id, billing: spec.billing, agentic: Boolean(spec.agentic) };

  const check = validateRefs(spec, options.refs ?? [], { duration: options.duration });
  json.warnings.push(...check.warnings);
  if (check.errors.length > 0) return fail(json, 2, check.errors.join('; '));
  if (check.forcedDuration !== undefined) options.duration = check.forcedDuration;

  let provider: ImageProvider;
  try {
    provider = deps.getProvider(spec.provider);
  } catch (err) {
    return fail(json, 1, message(err));
  }

  if (req.quoteOnly || req.maxCost !== undefined) {
    let price;
    try {
      price = await priceFor(spec, provider, options);
    } catch (err) {
      json.warnings.push(`price check failed: ${message(err)}`);
    }
    json.quote_usd = price?.usd ?? null;
    if (req.quoteOnly) {
      return price ? { ...json, ok: true, exit_code: 0 } : fail(json, 1, `no price available for ${spec.name} via ${spec.provider}`);
    }
    if (!price) return fail(json, 2, `--max-cost is set but no price is available for ${spec.name} via ${spec.provider}; nothing was sent`);
    if (price.usd > (req.maxCost as number)) {
      return fail(json, 2, `price $${price.usd.toFixed(4)} exceeds --max-cost $${req.maxCost}; nothing was sent`);
    }
  }

  let result: GenerationResult;
  try {
    result = await provider.generate(options);
  } catch (err) {
    return fail(json, 1, message(err));
  }
  return finish(json, result, Boolean(options.noWait), deps);
}

async function finish(json: ResultJson, result: GenerationResult, noWait: boolean, deps: RunDeps): Promise<ResultJson> {
  json = { ...json, job_id: result.jobId ?? json.job_id, request: result.request ?? json.request, provider_model_id: result.providerModelId ?? json.provider_model_id };
  if (result.pending) {
    if (noWait) return { ...json, ok: true, exit_code: 0, pending: true };
    return { ...fail(json, 75, `Still running. Resume with: generate --resume ${result.jobId}`), pending: true };
  }
  if (!result.success) return fail(json, 1, result.error ?? 'generation failed');
  const outputs = result.outputs ?? (result.outputPath ? [result.outputPath] : []);
  json = { ...json, ok: true, exit_code: 0, error: null, outputs };
  if (deps.stamp) {
    try {
      await deps.stamp(outputs, json);
    } catch (err) {
      json.warnings.push(`provenance stamp failed: ${message(err)}`);
    }
  }
  return json;
}

export async function resumeJob(id: string, opts: { waitSeconds?: number; onProgress?: (s: string) => void }, deps: RunDeps): Promise<ResultJson> {
  let json = emptyResult();
  const record = readJob(id);
  if (!record) return fail(json, 1, `No job record for ${id}. List jobs with: generate --jobs`);
  json = { ...json, provider: record.provider, model: record.model, provider_model_id: record.provider_model_id ?? null, job_id: record.id, request: record.request ?? null };
  if (record.status === 'completed') return { ...json, ok: true, exit_code: 0, outputs: record.outputs ?? [] };
  if (record.status === 'failed') return fail(json, 1, record.error?.message ?? 'job failed');

  let provider: ImageProvider;
  try {
    provider = deps.getProvider(record.provider);
  } catch (err) {
    return fail(json, 1, message(err));
  }
  if (!provider.resume) return fail(json, 1, `${record.provider} jobs cannot be resumed`);
  const result = await provider.resume(record, opts);
  return finish(json, result, false, deps);
}
