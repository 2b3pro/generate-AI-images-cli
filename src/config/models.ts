import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Model, ModelKind, ModelSpec, ObsoleteModel, Provider } from '../types';

/**
 * Model registry — loaded from config/models/*.yaml at startup.
 *
 * Each YAML file describes one provider's models. To add, rename, or retire a
 * model, edit the YAML; no code change is needed unless the provider needs a
 * new capability flag it does not yet understand.
 *
 * Lookup order for the config directory:
 *   1. $GENERATE_MODELS_DIR (explicit override)
 *   2. <package root>/config/models (works for `bun run dev`, `bun link`, and
 *      the bundled dist/cli.js, since all three sit inside the package tree)
 */

const KNOWN_PROVIDERS: Provider[] = ['replicate', 'openai', 'google'];
const KNOWN_KINDS: ModelKind[] = ['image', 'video'];

interface RawProviderFile {
  provider?: unknown;
  models?: Record<string, Record<string, unknown>>;
  obsolete?: Record<string, { replacement?: unknown; reason?: unknown }>;
}

export interface ModelRegistry {
  /** Canonical model name -> spec */
  models: Record<Model, ModelSpec>;
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
    if (!KNOWN_KINDS.includes(kind)) fail(file, `model "${name}": kind must be image or video`);
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

  const registry: ModelRegistry = { models: {}, aliases: {}, obsolete: {}, sourceDir: dir };
  const origin: Record<string, string> = {};

  for (const file of files) {
    const parsed = parseProviderFile(file);
    for (const spec of parsed.models) {
      if (registry.models[spec.name]) {
        fail(file, `model "${spec.name}" already defined in ${origin[spec.name]}`);
      }
      registry.models[spec.name] = spec;
      origin[spec.name] = file;
    }
    Object.assign(registry.obsolete, parsed.obsolete);
  }

  // Aliases are resolved after all models are known so they can be validated.
  for (const spec of Object.values(registry.models)) {
    for (const alias of spec.aliases) {
      if (registry.models[alias]) {
        fail(origin[spec.name], `alias "${alias}" on ${spec.name} collides with a model name`);
      }
      if (registry.aliases[alias] && registry.aliases[alias] !== spec.name) {
        fail(origin[spec.name], `alias "${alias}" is claimed by both ${registry.aliases[alias]} and ${spec.name}`);
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
  const { models, aliases, obsolete } = loadModelRegistry();
  const lower = modelName.trim().toLowerCase();
  if (lower in models) return lower;
  if (lower in aliases) return aliases[lower];
  const byId = Object.values(models).find((m) => m.id.toLowerCase() === lower);
  if (byId) return byId.name;
  if (lower in obsolete) {
    throw new Error(`Model "${modelName}" is obsolete: ${obsolete[lower].reason}`);
  }
  throw new Error(`Unknown model "${modelName}". Available models: ${Object.keys(models).join(', ')}`);
}

export function getModelSpec(model: Model): ModelSpec {
  const spec = loadModelRegistry().models[model];
  if (!spec) throw new Error(`Unknown model "${model}"`);
  return spec;
}

export function isVideoModel(model: string): boolean {
  const spec = loadModelRegistry().models[model.toLowerCase()];
  return spec?.kind === 'video';
}

export function listModelSpecs(): ModelSpec[] {
  return Object.values(loadModelRegistry().models);
}

export function modelsForProvider(provider: Provider): Model[] {
  return listModelSpecs()
    .filter((m) => m.provider === provider)
    .map((m) => m.name);
}
