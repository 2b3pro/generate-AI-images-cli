import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Billing, Model, ModelKind, ModelSpec, ObsoleteModel, Provider } from '../types';

/**
 * Model registry, loaded from config/models/*.yaml plus config/routing.yaml.
 *
 * One canonical model name may be offered by several providers (e.g. the same
 * image model directly and through a reseller). routing.yaml names the
 * provider that serves the name by default; --via and --billing select others.
 *
 * Lookup order for the config directory:
 *   1. $GENERATE_MODELS_DIR (explicit override)
 *   2. <package root>/config/models (works for `bun run dev`, `bun link`, and
 *      the bundled dist/cli.js, since all three sit inside the package tree)
 * routing.yaml: $GENERATE_ROUTING_FILE, else the models directory's parent.
 */

const KNOWN_PROVIDERS: Provider[] = ['replicate', 'openai', 'google', 'atlas', 'codex', 'agy'];
const KNOWN_KINDS: ModelKind[] = ['image', 'video', 'audio'];
const KNOWN_BILLING: Billing[] = ['metered', 'plan'];

export type BillingFilter = Billing | 'any';

export class NoBillingPathError extends Error {}

interface RawProviderFile {
  provider?: unknown;
  models?: Record<string, Record<string, unknown>>;
  obsolete?: Record<string, { replacement?: unknown; reason?: unknown }>;
}

export interface ModelRegistry {
  /** Canonical model name -> the spec routing selects */
  models: Record<Model, ModelSpec>;
  /** Canonical model name -> every provider's spec for that name */
  offers: Record<Model, Partial<Record<Provider, ModelSpec>>>;
  /** Canonical model name -> provider named in routing.yaml */
  routing: Record<Model, Provider>;
  /** Alias (lowercase) -> canonical model name */
  aliases: Record<string, Model>;
  /** Retired model name -> replacement + reason */
  obsolete: Record<string, ObsoleteModel>;
  /** Directory the registry was loaded from */
  sourceDir: string;
}

let cached: ModelRegistry | null = null;

function packageRoot(): string {
  // src/config/models.ts  -> ../../   (dev via `bun run`)
  // dist/cli.js           -> ../      (bundled)
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '..', '..'), path.resolve(here, '..')]) {
    if (fs.existsSync(path.join(candidate, 'config', 'models'))) return candidate;
  }
  return path.resolve(here, '..', '..');
}

export function modelsConfigDir(): string {
  const override = process.env.GENERATE_MODELS_DIR?.trim();
  if (override) return override;
  return path.join(packageRoot(), 'config', 'models');
}

export function routingFile(): string {
  const override = process.env.GENERATE_ROUTING_FILE?.trim();
  if (override) return override;
  return path.join(path.dirname(modelsConfigDir()), 'routing.yaml');
}

function fail(file: string, msg: string): never {
  throw new Error(`Invalid model config ${file}: ${msg}`);
}

function parseProviderFile(file: string): { provider: Provider; models: ModelSpec[]; obsolete: Record<string, ObsoleteModel> } {
  const text = fs.readFileSync(file, 'utf8');
  const raw = Bun.YAML.parse(text) as RawProviderFile | null;
  if (!raw || typeof raw !== 'object') fail(file, 'file is empty or not a YAML mapping');

  const provider = raw.provider;
  if (typeof provider !== 'string' || !KNOWN_PROVIDERS.includes(provider as Provider)) {
    fail(file, `"provider" must be one of ${KNOWN_PROVIDERS.join(', ')} (got ${JSON.stringify(provider)})`);
  }

  const models: ModelSpec[] = [];
  for (const [name, entry] of Object.entries(raw.models ?? {})) {
    if (!entry || typeof entry !== 'object') fail(file, `model "${name}" must be a mapping`);
    const kind = (entry.kind ?? 'image') as ModelKind;
    if (!KNOWN_KINDS.includes(kind)) fail(file, `model "${name}": kind must be image, video, or audio`);
    const billing = entry.billing as Billing;
    if (typeof billing !== 'string' || !KNOWN_BILLING.includes(billing)) {
      fail(file, `model "${name}": billing must be metered or plan`);
    }
    if (kind === 'video' && billing === 'plan') fail(file, `model "${name}": video models must be billing: metered`);
    const aliases = entry.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string')) {
      fail(file, `model "${name}": aliases must be a list of strings`);
    }
    const { id, description, deprecated, ...rest } = entry;
    models.push({
      ...rest,
      name: name.toLowerCase(),
      provider: provider as Provider,
      id: typeof id === 'string' && id ? id : name,
      kind,
      billing,
      description: typeof description === 'string' ? description : undefined,
      deprecated: typeof deprecated === 'string' ? deprecated : undefined,
      aliases: (aliases as string[]).map((a) => a.toLowerCase()),
    });
  }

  const obsolete: Record<string, ObsoleteModel> = {};
  for (const [name, entry] of Object.entries(raw.obsolete ?? {})) {
    if (!entry || typeof entry.replacement !== 'string' || typeof entry.reason !== 'string') {
      fail(file, `obsolete "${name}" needs string "replacement" and "reason"`);
    }
    obsolete[name.toLowerCase()] = { replacement: entry.replacement, reason: entry.reason };
  }

  return { provider: provider as Provider, models, obsolete };
}

function loadRouting(): Record<Model, Provider> {
  const file = routingFile();
  if (!fs.existsSync(file)) return {};
  const raw = Bun.YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  const routing: Record<Model, Provider> = {};
  for (const [name, provider] of Object.entries(raw ?? {})) {
    if (typeof provider !== 'string' || !KNOWN_PROVIDERS.includes(provider as Provider)) {
      throw new Error(`Invalid routing ${file}: "${name}" must map to one of ${KNOWN_PROVIDERS.join(', ')}`);
    }
    routing[name.toLowerCase()] = provider as Provider;
  }
  return routing;
}

function allSpecs(reg: ModelRegistry): ModelSpec[] {
  return Object.values(reg.offers).flatMap((byProvider) => Object.values(byProvider) as ModelSpec[]);
}

export function loadModelRegistry(force = false): ModelRegistry {
  if (cached && !force) return cached;

  const dir = modelsConfigDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`Model config directory not found: ${dir} (set GENERATE_MODELS_DIR to override)`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
  if (files.length === 0) {
    throw new Error(`No *.yaml model config files found in ${dir}`);
  }

  const registry: ModelRegistry = { models: {}, offers: {}, routing: {}, aliases: {}, obsolete: {}, sourceDir: dir };
  const origin: Record<string, string> = {};

  for (const file of files) {
    const parsed = parseProviderFile(file);
    for (const spec of parsed.models) {
      const key = `${spec.name}@${spec.provider}`;
      if (registry.offers[spec.name]?.[spec.provider]) {
        fail(file, `model "${spec.name}" already defined in ${origin[key]}`);
      }
      (registry.offers[spec.name] ??= {})[spec.provider] = spec;
      origin[key] = file;
    }
    Object.assign(registry.obsolete, parsed.obsolete);
  }

  const routing = loadRouting();
  for (const [name, provider] of Object.entries(routing)) {
    const offers = registry.offers[name];
    if (!offers) throw new Error(`Invalid routing ${routingFile()}: unknown model "${name}"`);
    if (!offers[provider]) {
      throw new Error(`Invalid routing ${routingFile()}: ${name} is not offered by ${provider} (offered by: ${Object.keys(offers).join(', ')})`);
    }
  }
  registry.routing = routing;

  for (const [name, byProvider] of Object.entries(registry.offers)) {
    const providers = Object.keys(byProvider) as Provider[];
    if (providers.length === 1) {
      registry.models[name] = byProvider[providers[0]]!;
      continue;
    }
    const chosen = routing[name];
    if (!chosen) {
      throw new Error(`Invalid routing: model "${name}" is offered by ${providers.join(', ')}; choose one in ${routingFile()}`);
    }
    registry.models[name] = byProvider[chosen]!;
  }

  // Aliases are resolved after all models are known so they can be validated.
  for (const spec of allSpecs(registry)) {
    for (const alias of spec.aliases) {
      if (registry.offers[alias]) {
        fail(origin[`${spec.name}@${spec.provider}`], `alias "${alias}" on ${spec.name} collides with a model name`);
      }
      if (registry.aliases[alias] && registry.aliases[alias] !== spec.name) {
        fail(origin[`${spec.name}@${spec.provider}`], `alias "${alias}" is claimed by both ${registry.aliases[alias]} and ${spec.name}`);
      }
      registry.aliases[alias] = spec.name;
    }
  }
  for (const [name, obs] of Object.entries(registry.obsolete)) {
    if (!registry.models[obs.replacement]) {
      throw new Error(`Invalid model config: obsolete "${name}" points at unknown replacement "${obs.replacement}"`);
    }
  }

  cached = registry;
  return registry;
}

/** Resolve a user-supplied model name (canonical, alias, or provider id) to its canonical name. */
export function resolveModel(modelName: string): Model {
  const reg = loadModelRegistry();
  const lower = modelName.trim().toLowerCase();
  if (lower in reg.models) return lower;
  if (lower in reg.aliases) return reg.aliases[lower];
  const byId = allSpecs(reg).find((m) => m.id.toLowerCase() === lower);
  if (byId) return byId.name;
  if (lower in reg.obsolete) {
    throw new Error(`Model "${modelName}" is obsolete: ${reg.obsolete[lower].reason}`);
  }
  throw new Error(`Unknown model "${modelName}". Available models: ${Object.keys(reg.models).join(', ')}`);
}

/** The routed spec for a name, or a specific provider's spec when `provider` is given. */
export function getModelSpec(model: Model, provider?: Provider): ModelSpec {
  const reg = loadModelRegistry();
  if (provider) {
    const spec = reg.offers[model]?.[provider];
    if (!spec) throw new Error(`Model "${model}" is not offered by ${provider}`);
    return spec;
  }
  const spec = reg.models[model];
  if (!spec) throw new Error(`Unknown model "${model}"`);
  return spec;
}

export function listOffers(model: Model): ModelSpec[] {
  return Object.values(loadModelRegistry().offers[model] ?? {}) as ModelSpec[];
}

/**
 * Choose the spec that will serve a request.
 * - via: that provider's spec, which must also match a non-"any" billing filter.
 * - billing "any": the routed spec.
 * - billing plan/metered: the routed spec if it matches, else the cheapest
 *   matching offer by direct_price (unknown price sorts last). Never crosses
 *   billing kinds; throws NoBillingPathError instead.
 */
export function selectSpec(model: Model, opts: { via?: Provider; billing?: BillingFilter } = {}): ModelSpec {
  const reg = loadModelRegistry();
  const offers = reg.offers[model];
  if (!offers) throw new Error(`Unknown model "${model}"`);
  const billing = opts.billing ?? 'any';

  if (opts.via) {
    const spec = offers[opts.via];
    if (!spec) throw new Error(`${model} is not offered by ${opts.via}. Offered by: ${Object.keys(offers).join(', ')}`);
    if (billing !== 'any' && spec.billing !== billing) {
      throw new NoBillingPathError(`${model} via ${opts.via} is ${spec.billing}-billed, not ${billing}-billed`);
    }
    return spec;
  }

  const active = reg.models[model];
  if (billing === 'any' || active.billing === billing) return active;

  const matching = (Object.values(offers) as ModelSpec[])
    .filter((s) => s.billing === billing)
    .sort((a, b) => (a.direct_price?.usd ?? Infinity) - (b.direct_price?.usd ?? Infinity) || a.provider.localeCompare(b.provider));
  if (matching.length > 0) return matching[0];

  const alternatives = allSpecs(reg)
    .filter((s) => s.kind === active.kind && s.billing === billing)
    .map((s) => `${s.name} (${s.provider})`);
  throw new NoBillingPathError(
    `no ${billing}-billed path for ${model}; ` +
      (alternatives.length ? `${billing}-billed ${active.kind} models: ${alternatives.join(', ')}` : `no ${billing}-billed ${active.kind} models exist`)
  );
}

export function isVideoModel(model: string): boolean {
  const spec = loadModelRegistry().models[model.toLowerCase()];
  return spec?.kind === 'video';
}

/** One routed spec per canonical name. */
export function listModelSpecs(): ModelSpec[] {
  return Object.values(loadModelRegistry().models);
}

/** Every name this provider offers, routed or not. */
export function modelsForProvider(provider: Provider): Model[] {
  return allSpecs(loadModelRegistry())
    .filter((m) => m.provider === provider)
    .map((m) => m.name);
}
