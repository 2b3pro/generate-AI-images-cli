# Atlas, Codex, and Antigravity Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Atlas Cloud (image, video, audio), Codex, and Antigravity as `generate` providers, with resumable async jobs, cost-based routing, billing-kind guarantees, role-typed references validated before spend, draft tiers, and reproducible provenance.

**Architecture:** The model registry becomes multi-provider: one canonical name can be offered by several providers, and `config/routing.yaml` picks the active one. A shared job layer (`src/utils/jobs.ts`) records every async submission before polling, so Atlas and Veo jobs are resumed by id and never resubmitted. Pure modules (`refs.ts`, `cost.ts`, `run.ts`) hold the decisions; `cli.ts` only parses flags and prints.

**Tech Stack:** Bun 1.3, TypeScript, commander, `bun:test`, `fetch`, `Bun.spawn`; external tools already present on the target machine: `sips`, ImageMagick (`magick`), `file`, `exiftool`.

**Spec:** `docs/specs/2026-10-04-atlas-provider-design.md` (approved 2026-10-04). Background research the spec cites: model reference rules and video practice summarised in its Background and Architecture sections.

## Global Constraints

- Runtime Bun 1.3.x; `bunx tsc --noEmit` must pass at the end of every task.
- No new runtime dependencies. Use `fetch`, `Bun.spawn`, `Bun.YAML`, and the existing packages.
- This repository is public: no personal names, home-directory paths, or account details in code, config, fixtures, or docs. No em-dashes in docs.
- A generation **submit** request is sent exactly once. Never retry a POST to `/model/generate*`. Polling GETs may retry with backoff.
- Existing model names, flags, defaults (`nano-banana-2`, 16:9, `/tmp/generated-image.png`), and the meaning of untyped `-r` stay unchanged.
- Exit codes: `0` success (or `--no-wait` submitted), `1` failure, `2` rejected before anything was sent, `75` still running (resume with `generate --resume <id>`).
- Atlas key: `ATLASCLOUD_API_KEY` env var, then macOS Keychain service `ATLASCLOUD_API_KEY`, via the existing `resolveApiKey`.
- Atlas base URL `https://api.atlascloud.ai/api/v1`; submit `POST /model/generateImage|generateVideo|generateAudio` returns `data.id`; poll `GET /model/prediction/{id}` returns `data.status` in `processing|completed|failed`, `data.outputs[]`, `data.error`, `data.error_code`; upload `POST /model/uploadMedia` multipart field `file`; price `POST /model/calculate` takes the same body as the generate endpoint, creates no task, charges nothing.
- Atlas model ids and request field names come only from each model's reference page, confirmed by `scripts/verify-atlas-models.ts`; never from guide-page examples.
- Every `billing: plan` spec is image-only; `kind: video` with `billing: plan` is a load-time error.
- Automated tests never touch the network or real agent CLIs. Live calls happen only in Task 10 (free: upload and calculate) and Task 11 (paid smoke, owner go-ahead required, about USD 1).
- The globally installed `generate` runs `dist/cli.js` (gitignored); `bun run build` is required for changes to reach it.

## Review Focus

1. **Provider returns a different file type than requested** (`-o out.png` but Atlas serves a JPEG or MP4): the file is written with the real extension and the result names the real path. Pinned in Task 6 (`atlas.test.ts`, "submits once, records the job before polling, downloads with the served extension").
2. **The process dies or is interrupted mid-poll**: a job record already exists, `--jobs` lists it as pending, and `--resume` finishes it. Pinned in Task 6 (same test: it reads the job record at the moment of the first poll and expects `pending`).
3. **`--resume` on a job that already completed**: returns the recorded outputs without any network call. Pinned in Task 8 (`run.test.ts`, "resume of a completed job").
4. **Reference paths with spaces or relative paths given to an agent backend**: the agent receives absolute, symlink-resolved paths. Pinned in Task 7 (`agents.test.ts`, "resolves reference paths").
5. **Two `generate` processes writing job records at once**: records are written via temp file plus rename, so a reader never sees a partial file. Pinned in Task 3 (`jobs.test.ts`, "writes atomically").

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` (modify) | All shared types: providers, kinds, billing, reference roles, job and request records, extended options and results |
| `src/config/models.ts` (modify) | Multi-provider registry, `routing.yaml`, billing validation, `selectSpec` |
| `config/routing.yaml` (create) | Which provider serves each shared model name |
| `config/models/{google,openai,replicate}.yaml` (modify) | Add `billing: metered`; later `direct_price` on shared models |
| `config/models/{atlas,codex,agy}.yaml` (create) | New provider catalogs |
| `src/refs.ts` (create) | Parse, annotate, validate, and label role-typed references |
| `src/params.ts` (create) | Parse `--param key=value` |
| `src/utils/jobs.ts` (create) | Job records and the poll loop |
| `src/utils/download.ts` (modify) | `extFor`, `outputPathFor` |
| `src/utils/staged-agent.ts` (create) | Stage directory, agent prompt, agent process, conversion, MIME check |
| `src/utils/provenance.ts` (create) | XMP stamping via exiftool |
| `src/providers/atlas-client.ts` (create) | Atlas HTTP calls only |
| `src/providers/atlas.ts` (create) | Atlas request building and job flow |
| `src/providers/codex.ts`, `src/providers/agy.ts` (create) | Agent providers |
| `src/providers/google.ts` (modify) | Veo on the job layer, `resume` |
| `src/providers/{openai,replicate}.ts`, `src/providers/index.ts` (modify) | Provider-scoped spec lookup, registration |
| `src/cost.ts` (create) | Price lookup (quote or list price) |
| `src/run.ts` (create) | Orchestration: select, draft, validate, price, generate, map to result JSON and exit code |
| `src/cli.ts` (modify) | Flags, `--jobs`, `--resume`, `--json`, printing |
| `scripts/verify-atlas-models.ts`, `scripts/quote-table.ts` (create) | Catalog verification, price comparison |
| `test/helpers/registry.ts`, `test/fixtures/registry.ts`, `test/fixtures/stub-agent.sh` (create) | Test support |

---

### Task 1: Types and multi-provider registry

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config/models.ts` (full replacement below)
- Modify: `src/providers/index.ts`, `src/providers/google.ts:83,97,281`, `src/providers/openai.ts:131`, `src/providers/replicate.ts:36`
- Modify: `src/cli.ts:37-61` (`--list-models` display)
- Modify: `config/models/google.yaml`, `config/models/openai.yaml`, `config/models/replicate.yaml`
- Create: `config/routing.yaml`, `test/helpers/registry.ts`, `test/fixtures/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Produces (types): `Provider`, `ModelKind`, `Billing`, `RefRole`, `REF_ROLES`, `LabelStyle`, `RoleRef`, `RefCaps`, `DirectPrice`, `DraftTier`, `AtlasInputs`, `RequestRecord`, `JobStatus`, `JobRecord`; extended `ModelSpec`, `GenerateOptions`, `GenerationResult`, `ImageProvider`.
- Produces (registry): `type BillingFilter = Billing | 'any'`; `class NoBillingPathError extends Error`; `selectSpec(model: Model, opts?: { via?: Provider; billing?: BillingFilter }): ModelSpec`; `getModelSpec(model: Model, provider?: Provider): ModelSpec`; `listOffers(model: Model): ModelSpec[]`; `routingFile(): string`; `ModelRegistry.offers`, `ModelRegistry.routing`.
- Produces (tests): `writeRegistry(files, routing?)`, `useRealRegistry()`, `tmpDir(prefix?)`, `FIXTURE_FILES`, `FIXTURE_ROUTING`.

- [ ] **Step 1: Extend `src/types.ts`**

Replace the first two type lines and the `ModelSpec` interface, and add the new types. Change:

```ts
export type Provider = 'replicate' | 'openai' | 'google';
```
to:
```ts
export type Provider = 'replicate' | 'openai' | 'google' | 'atlas' | 'codex' | 'agy';
```

Change `export type ModelKind = 'image' | 'video';` to:

```ts
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
```

In `interface ModelSpec`, after `deprecated?: string;` add:

```ts
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
```

and change `inputs?: ReplicateInputs;` to `inputs?: ReplicateInputs & AtlasInputs;`.

In `interface GenerateOptions`, after `numImages?: number;` add:

```ts
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
```

Replace `interface GenerationResult` and `interface ImageProvider` with:

```ts
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
  quote?(options: GenerateOptions): Promise<number>;
}
```

In `DEFAULT_OPTIONS` add after `videoOutput`: `audioOutput: '/tmp/generated-audio.mp3',`.

- [ ] **Step 2: Write the test helpers and fixture registry**

`test/helpers/registry.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadModelRegistry } from '../../src/config/models';

/** Write provider YAML files (and optional routing.yaml) to a temp dir and load them. */
export function writeRegistry(files: Record<string, string>, routing?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-reg-'));
  const models = path.join(root, 'models');
  fs.mkdirSync(models);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(models, name), text);
  if (routing !== undefined) fs.writeFileSync(path.join(root, 'routing.yaml'), routing);
  process.env.GENERATE_MODELS_DIR = models;
  delete process.env.GENERATE_ROUTING_FILE;
  loadModelRegistry(true);
  return root;
}

export function useRealRegistry(): void {
  delete process.env.GENERATE_MODELS_DIR;
  delete process.env.GENERATE_ROUTING_FILE;
  loadModelRegistry(true);
}

export function tmpDir(prefix = 'gen-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
```

`test/fixtures/registry.ts`:

```ts
export const FIXTURE_FILES: Record<string, string> = {
  'google.yaml': `
provider: google
models:
  img-shared:
    id: g-img
    kind: image
    billing: metered
    direct_price: { usd: 0.10, unit: image }
  vid-shared:
    id: g-vid
    kind: video
    billing: metered
    direct_price: { usd: 0.40, unit: second }
    draft: { model: vid-lite }
  vid-lite:
    id: g-vid-lite
    kind: video
    billing: metered
    direct_price: { usd: 0.05, unit: second }
`,
  'atlas.yaml': `
provider: atlas
models:
  img-shared:
    id: vendor/img/text-to-image
    edit_id: vendor/img/edit
    kind: image
    billing: metered
    label_style: at-index
    refs: { identity: 2, style: 1, object: 2, location: 1 }
    inputs: { images: images, max_images: 3, aspect_ratio: aspect_ratio, resolution: resolution, resolution_values: { 1K: 1k, 2K: 2k }, seed: seed }
  vid-shared:
    id: vendor/vid/text-to-video
    i2v_id: vendor/vid/image-to-video
    r2v_id: vendor/vid/reference-to-video
    kind: video
    billing: metered
    label_style: prose
    refs: { start: 1, end: 1, identity: 3, exclusive: [[start, identity], [end, identity]], forces: { identity: { duration: 8 } }, max_people_warning: 2 }
    draft: { resolution: 480p }
    inputs: { image: image, end_image: end_image, images: reference_images, duration: duration, resolution: resolution, seed: seed, negative_prompt: negative_prompt }
  tts-only:
    id: vendor/tts
    kind: audio
    billing: metered
    inputs: { prompt: text }
`,
  'codex.yaml': `
provider: codex
models:
  img-shared:
    id: gpt-image-2
    kind: image
    billing: plan
    agentic: true
    reasoning_effort: high
    direct_price: { usd: 0, unit: plan limits }
`,
  'agy.yaml': `
provider: agy
models:
  agy-image:
    id: agy default agent model
    kind: image
    billing: plan
    agentic: true
`,
};

export const FIXTURE_ROUTING = `
img-shared: google
vid-shared: atlas
`;
```

- [ ] **Step 3: Write the failing registry tests**

`test/registry.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { getModelSpec, listOffers, loadModelRegistry, NoBillingPathError, selectSpec } from '../src/config/models';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { useRealRegistry, writeRegistry } from './helpers/registry';

afterAll(useRealRegistry);

describe('registry validation', () => {
  test('rejects a spec without billing', () => {
    expect(() => writeRegistry({ 'google.yaml': 'provider: google\nmodels:\n  x:\n    kind: image\n' })).toThrow(/billing must be metered or plan/);
  });

  test('rejects a plan-billed video model', () => {
    expect(() =>
      writeRegistry({ 'codex.yaml': 'provider: codex\nmodels:\n  v:\n    kind: video\n    billing: plan\n' })
    ).toThrow(/video models must be billing: metered/);
  });

  test('a name offered by two providers needs a routing entry', () => {
    const { 'google.yaml': g, 'atlas.yaml': a } = FIXTURE_FILES;
    expect(() => writeRegistry({ 'google.yaml': g, 'atlas.yaml': a }, '')).toThrow(/img-shared.*offered by.*routing/);
  });

  test('routing naming a provider that does not offer the model fails', () => {
    expect(() => writeRegistry(FIXTURE_FILES, 'img-shared: replicate\nvid-shared: atlas\n')).toThrow(/not offered by replicate/);
  });
});

describe('selection', () => {
  test('routing picks the active spec; provider lookup reaches the others', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(getModelSpec('img-shared').provider).toBe('google');
    expect(getModelSpec('img-shared', 'atlas').id).toBe('vendor/img/text-to-image');
    expect(listOffers('img-shared').map((s) => s.provider).sort()).toEqual(['atlas', 'codex', 'google']);
  });

  test('--via selects a provider and rejects one that does not offer the model', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(selectSpec('img-shared', { via: 'atlas' }).provider).toBe('atlas');
    expect(() => selectSpec('vid-lite', { via: 'atlas' })).toThrow(/not offered by atlas/);
  });

  test('--via combined with a contradicting --billing is rejected', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(() => selectSpec('img-shared', { via: 'atlas', billing: 'plan' })).toThrow(NoBillingPathError);
  });

  test('billing plan picks the plan offer even when routing is metered', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(selectSpec('img-shared', { billing: 'plan' }).provider).toBe('codex');
  });

  test('billing plan with no plan offer names the alternatives', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    expect(() => selectSpec('vid-shared', { billing: 'plan' })).toThrow(/no plan-billed path for vid-shared; no plan-billed video models exist/);
    try {
      selectSpec('tts-only', { billing: 'plan' });
    } catch (err) {
      expect(err).toBeInstanceOf(NoBillingPathError);
    }
  });

  test('billing metered skips a plan-routed name and takes the cheapest metered offer', () => {
    writeRegistry(FIXTURE_FILES, 'img-shared: codex\nvid-shared: atlas\n');
    expect(selectSpec('img-shared', { billing: 'metered' }).provider).toBe('google');
  });
});

describe('real config', () => {
  test('loads, and existing names keep their direct provider', () => {
    useRealRegistry();
    const reg = loadModelRegistry();
    expect(reg.models['nano-banana-2'].provider).toBe('google');
    expect(reg.models['nano-banana-2'].billing).toBe('metered');
    expect(reg.models['gpt-image-2'].provider).toBe('openai');
  });
});
```

Note on the "cheapest metered" test: atlas `img-shared` has no `direct_price`, so it sorts as `Infinity` and google (0.10) wins.

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test test/registry.test.ts`
Expected: FAIL (`listOffers`, `selectSpec`, `NoBillingPathError` are not exported; billing is not validated).

- [ ] **Step 5: Replace `src/config/models.ts`**

```ts
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
 *   2. <package root>/config/models
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
```

- [ ] **Step 6: Add `billing: metered` to every existing model and create `config/routing.yaml`**

Run:

```bash
for f in config/models/google.yaml config/models/openai.yaml config/models/replicate.yaml; do
  perl -0pi -e 's/^(    kind: (?:image|video)\n)/$1    billing: metered\n/mg' "$f"
done
grep -c 'billing: metered' config/models/*.yaml
```

Expected: a non-zero count per file. The real-config test ("loads, and existing names keep their direct provider") fails with `billing must be metered or plan` and the model's name if any entry was missed (an entry without a `kind:` line); add `    billing: metered` under that entry's `id:` by hand.

Also add one line to the header comment block of each of those three files, after the `kind` line:

```yaml
#   billing       metered (charged per call) | plan (subscription usage limits). Required.
```

Create `config/routing.yaml`:

```yaml
# Which provider serves a model name offered by more than one provider.
# Edited by hand from `bun scripts/quote-table.ts`. Flip rule: a reseller
# becomes preferred only when its quote is at least 10% below the direct list
# price AND a side-by-side on the same prompts shows parity.
# A name offered by one provider needs no entry; a shared name without an
# entry is a load-time error.
```

(The file has no entries yet; Task 10 adds them when the shared names exist.)

- [ ] **Step 7: Scope provider spec lookups to their own provider**

Run:

```bash
sed -i '' "s/getModelSpec(model)\.kind === 'video'/getModelSpec(model, 'google').kind === 'video'/" src/providers/google.ts
sed -i '' "s/getModelSpec(options\.model);/getModelSpec(options.model, 'google');/g" src/providers/google.ts
sed -i '' "s/getModelSpec(options\.model);/getModelSpec(options.model, 'openai');/" src/providers/openai.ts
sed -i '' "s/getModelSpec(options\.model);/getModelSpec(options.model, 'replicate');/" src/providers/replicate.ts
grep -n "getModelSpec(" src/providers/*.ts
```

Expected: every provider call passes its own provider name; `index.ts:34` still calls `getModelSpec(model)`.

In `src/providers/index.ts`, export the factory and add a spec-based getter, and widen `listModels`:

```ts
import type { Billing, ImageProvider, Model, ModelKind, ModelSpec, Provider } from '../types';
import { getModelSpec, listModelSpecs, listOffers, resolveModel } from '../config/models';
```

Change `function getOrCreateProvider` to `export function getOrCreateProvider`, and replace `listModels` with:

```ts
export function getProviderForSpec(spec: ModelSpec): ImageProvider {
  return getOrCreateProvider(spec.provider);
}

export function listModels(): {
  model: Model;
  provider: Provider;
  kind: ModelKind;
  billing: Billing;
  description?: string;
  aliases: string[];
  deprecated?: string;
  alternatives: { provider: Provider; billing: Billing }[];
}[] {
  return listModelSpecs().map((m) => ({
    model: m.name,
    provider: m.provider,
    kind: m.kind,
    billing: m.billing,
    description: m.description,
    aliases: m.aliases,
    deprecated: m.deprecated,
    alternatives: listOffers(m.name)
      .filter((o) => o.provider !== m.provider)
      .map((o) => ({ provider: o.provider, billing: o.billing })),
  }));
}
```

- [ ] **Step 8: Update the `--list-models` display in `src/cli.ts`**

Replace the inner loop body (lines 50-57) with:

```ts
    for (const { model, kind, billing, description, aliases, deprecated, alternatives } of providerModels) {
      const tag = kind === 'video' ? chalk.yellow(' [VIDEO]') : kind === 'audio' ? chalk.magenta(' [AUDIO]') : chalk.dim(' [IMAGE]');
      const billed = billing === 'plan' ? chalk.green(' (plan)') : '';
      const isDefault = model === DEFAULT_OPTIONS.model ? chalk.green(' (default)') : '';
      console.log(`    - ${chalk.bold(model)}${tag}${billed}${isDefault}`);
      if (description) console.log(chalk.dim(`        ${description}`));
      if (deprecated) console.log(chalk.yellow(`        deprecated: ${deprecated}`));
      if (aliases.length) console.log(chalk.dim(`        aliases: ${aliases.join(', ')}`));
      if (alternatives.length) {
        console.log(chalk.dim(`        also via: ${alternatives.map((a) => `${a.provider}${a.billing === 'plan' ? ' (plan)' : ''}`).join(', ')}`));
      }
    }
```

- [ ] **Step 9: Run tests and typecheck**

Run: `bun test test/registry.test.ts && bunx tsc --noEmit && bun run src/cli.ts --list-models | head -20`
Expected: all registry tests PASS; tsc exits 0; the model list prints as before.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/config/models.ts src/providers config test src/cli.ts
git commit -m "feat(registry): multi-provider names, routing.yaml, billing kinds, selectSpec"
```

---

### Task 2: Role-typed references and params

**Files:**
- Create: `src/refs.ts`, `src/params.ts`
- Test: `test/refs.test.ts`

**Interfaces:**
- Consumes: `ModelSpec`, `RoleRef`, `RefRole`, `REF_ROLES`, `LabelStyle` (Task 1).
- Produces: `parseRefArg(arg: string): RoleRef`; `attachNotes(refs: RoleRef[], notes: string[]): RoleRef[]`; `interface RefCheck { errors: string[]; warnings: string[]; forcedDuration?: number }`; `validateRefs(spec: ModelSpec, refs: RoleRef[], ctx: { duration?: number }): RefCheck`; `renderRefLabels(style: LabelStyle | undefined, refs: RoleRef[]): string`; `parseParams(list: string[]): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

`test/refs.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { getModelSpec } from '../src/config/models';
import { parseParams } from '../src/params';
import { attachNotes, parseRefArg, renderRefLabels, validateRefs } from '../src/refs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { useRealRegistry, writeRegistry } from './helpers/registry';

afterAll(useRealRegistry);

describe('parsing', () => {
  test('parses role=path, keeping "=" inside the path', () => {
    expect(parseRefArg('identity=/tmp/a=b.png')).toEqual({ role: 'identity', source: '/tmp/a=b.png' });
  });
  test('rejects unknown roles and missing parts', () => {
    expect(() => parseRefArg('face=/tmp/a.png')).toThrow(/Unknown reference role "face"/);
    expect(() => parseRefArg('/tmp/a.png')).toThrow(/expects <role>=<path\|url>/);
    expect(() => parseRefArg('start=')).toThrow(/needs a path or URL/);
  });
  test('attaches 1-based notes', () => {
    const refs = attachNotes([parseRefArg('identity=a.png'), parseRefArg('style=b.png')], ['2=palette only']);
    expect(refs[1].note).toBe('palette only');
    expect(() => attachNotes(refs, ['3=x'])).toThrow(/has no matching --ref/);
  });
  test('params parse JSON values and fall back to strings', () => {
    expect(parseParams(['duration=5', 'sound=true', 'voice=Aria', 'cfg={"a":1}'])).toEqual({ duration: 5, sound: true, voice: 'Aria', cfg: { a: 1 } });
    expect(() => parseParams(['novalue'])).toThrow(/--param expects key=value/);
  });
});

describe('validation', () => {
  test('model without ref caps rejects role refs', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    const check = validateRefs(getModelSpec('img-shared', 'google'), [parseRefArg('identity=a.png')], {});
    expect(check.errors[0]).toMatch(/does not accept role-typed references/);
  });
  test('count, total, and unknown-role limits', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    const spec = getModelSpec('img-shared', 'atlas');
    const refs = ['identity=a', 'identity=b', 'identity=c', 'start=d'].map(parseRefArg);
    const { errors } = validateRefs(spec, refs, {});
    expect(errors).toContain('img-shared (atlas) accepts at most 2 "identity" reference(s); got 3');
    expect(errors).toContain('img-shared (atlas) does not accept a "start" reference');
    expect(errors.some((e) => e.includes('in total'))).toBe(false);
  });
  test('total image-reference cap', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    const spec = getModelSpec('img-shared', 'atlas');
    const refs = ['identity=a', 'identity=b', 'object=c', 'object=d'].map(parseRefArg);
    expect(validateRefs(spec, refs, {}).errors).toContain('img-shared (atlas) accepts at most 3 reference images in total; got 4');
  });
  test('exclusive groups, forced duration, people warning', () => {
    writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
    const spec = getModelSpec('vid-shared', 'atlas');
    const excl = validateRefs(spec, ['start=a', 'identity=b'].map(parseRefArg), {});
    expect(excl.errors).toContain('vid-shared (atlas) cannot combine start and identity references');
    const forced = validateRefs(spec, ['identity=a', 'identity=b', 'identity=c'].map(parseRefArg), { duration: 5 });
    expect(forced.errors).toEqual([]);
    expect(forced.forcedDuration).toBe(8);
    expect(forced.warnings.some((w) => w.includes('overridden to 8s'))).toBe(true);
    expect(forced.warnings.some((w) => w.includes('unstable with more people'))).toBe(true);
  });
});

describe('labels', () => {
  const refs = attachNotes(['identity=a', 'style=b'].map(parseRefArg), ['1=the man in the centre']);
  test('at-index', () => {
    expect(renderRefLabels('at-index', refs)).toBe(
      '@Image1: identity reference: keep this person or character recognisably the same (the man in the centre).\n' +
        '@Image2: style reference: match its look, not its content.'
    );
  });
  test('wan-numbered', () => {
    expect(renderRefLabels('wan-numbered', refs).split('\n')[1]).toBe('Image 2: style reference: match its look, not its content.');
  });
  test('prose (default)', () => {
    expect(renderRefLabels(undefined, refs)).toBe(
      'Reference images: the first image is the identity reference: keep this person or character recognisably the same (the man in the centre); the second image is the style reference: match its look, not its content.'
    );
  });
  test('empty refs render nothing', () => {
    expect(renderRefLabels('prose', [])).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/refs.test.ts`
Expected: FAIL with "Cannot find module '../src/refs'".

- [ ] **Step 3: Implement `src/params.ts`**

```ts
/** Parse repeatable --param key=value. Values that parse as JSON keep their type. */
export function parseParams(list: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of list) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`--param expects key=value, got "${item}"`);
    const key = item.slice(0, eq).trim();
    const raw = item.slice(eq + 1);
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement `src/refs.ts`**

```ts
import type { LabelStyle, ModelSpec, RefRole, RoleRef } from './types';
import { REF_ROLES } from './types';

const ROLE_TEXT: Record<RefRole, string> = {
  start: 'first frame of the video',
  end: 'last frame of the video',
  identity: 'identity reference: keep this person or character recognisably the same',
  style: 'style reference: match its look, not its content',
  object: 'object reference: keep this object or product accurate',
  location: 'location reference: keep this setting consistent',
};

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

export function parseRefArg(arg: string): RoleRef {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new Error(`--ref expects <role>=<path|url>, got "${arg}"`);
  const role = arg.slice(0, eq).trim().toLowerCase() as RefRole;
  const source = arg.slice(eq + 1).trim();
  if (!REF_ROLES.includes(role)) throw new Error(`Unknown reference role "${role}". Roles: ${REF_ROLES.join(', ')}`);
  if (!source) throw new Error(`--ref ${role}= needs a path or URL`);
  return { role, source };
}

export function attachNotes(refs: RoleRef[], notes: string[]): RoleRef[] {
  const out = refs.map((r) => ({ ...r }));
  for (const n of notes) {
    const m = n.match(/^(\d+)=([\s\S]+)$/);
    if (!m) throw new Error(`--ref-note expects <n>=<text>, got "${n}"`);
    const i = Number(m[1]);
    if (i < 1 || i > out.length) throw new Error(`--ref-note ${i} has no matching --ref (there are ${out.length})`);
    out[i - 1].note = m[2].trim();
  }
  return out;
}

export interface RefCheck {
  errors: string[];
  warnings: string[];
  forcedDuration?: number;
}

/** Check role-typed references against the spec's rules. Pure; sends nothing. */
export function validateRefs(spec: ModelSpec, refs: RoleRef[], ctx: { duration?: number }): RefCheck {
  const check: RefCheck = { errors: [], warnings: [] };
  if (refs.length === 0) return check;
  const where = `${spec.name} (${spec.provider})`;
  const caps = spec.refs;
  if (!caps) {
    check.errors.push(`${where} does not accept role-typed references (--ref)`);
    return check;
  }

  const counts = new Map<RefRole, number>();
  for (const r of refs) counts.set(r.role, (counts.get(r.role) ?? 0) + 1);

  for (const [role, n] of counts) {
    const max = caps[role] ?? 0;
    if (max === 0) check.errors.push(`${where} does not accept a "${role}" reference`);
    else if (n > max) check.errors.push(`${where} accepts at most ${max} "${role}" reference(s); got ${n}`);
  }

  const imageRefs = refs.filter((r) => r.role !== 'start' && r.role !== 'end').length;
  const totalMax = spec.inputs?.max_images;
  if (totalMax !== undefined && imageRefs > totalMax) {
    check.errors.push(`${where} accepts at most ${totalMax} reference images in total; got ${imageRefs}`);
  }

  for (const group of caps.exclusive ?? []) {
    const present = group.filter((role) => counts.has(role));
    if (present.length > 1) check.errors.push(`${where} cannot combine ${present.join(' and ')} references`);
  }

  for (const role of counts.keys()) {
    const forced = caps.forces?.[role]?.duration;
    if (forced === undefined) continue;
    if (ctx.duration !== undefined && ctx.duration !== forced) {
      check.warnings.push(`duration ${ctx.duration}s overridden to ${forced}s: ${where} requires it with a "${role}" reference`);
    }
    check.forcedDuration = forced;
  }

  const identities = counts.get('identity') ?? 0;
  if (caps.max_people_warning !== undefined && identities > caps.max_people_warning) {
    check.warnings.push(`${identities} identity references exceeds ${caps.max_people_warning}; ${where} becomes unstable with more people`);
  }
  return check;
}

/** Text appended to the prompt that tells the model what each reference image is for. */
export function renderRefLabels(style: LabelStyle | undefined, refs: RoleRef[]): string {
  if (refs.length === 0) return '';
  const describe = (r: RoleRef) => ROLE_TEXT[r.role] + (r.note ? ` (${r.note})` : '');
  if (style === 'at-index') return refs.map((r, i) => `@Image${i + 1}: ${describe(r)}.`).join('\n');
  if (style === 'wan-numbered') return refs.map((r, i) => `Image ${i + 1}: ${describe(r)}.`).join('\n');
  const ordinal = (i: number) => ORDINALS[i] ?? `#${i + 1}`;
  return 'Reference images: ' + refs.map((r, i) => `the ${ordinal(i)} image is the ${describe(r)}`).join('; ') + '.';
}
```

Note: `max_people_warning` counts identity references, a reliable proxy for the number of people; the spec's wording ("people the prompt names") is not machine-checkable without parsing prose.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test test/refs.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/refs.ts src/params.ts test/refs.test.ts
git commit -m "feat(refs): role-typed references with pre-spend validation and prompt labels"
```

---

### Task 3: Job records and the poll loop

**Files:**
- Create: `src/utils/jobs.ts`
- Test: `test/jobs.test.ts`

**Interfaces:**
- Consumes: `JobRecord`, `ModelKind` (Task 1).
- Produces: `DEFAULT_WAIT_SECONDS: Record<ModelKind, number>`; `POLL_INTERVAL_MS: Record<ModelKind, number>`; `jobsDir(): string`; `writeJob(rec: JobRecord): void`; `readJob(id: string): JobRecord | undefined`; `updateJob(id: string, patch: Partial<JobRecord>): JobRecord`; `listJobs(): JobRecord[]`; `type PollState`; `class RetryableError extends Error`; `interface WaitOptions`; `waitForJob(poll: () => Promise<PollState>, o: WaitOptions): Promise<PollState | { status: 'timeout' }>`.

- [ ] **Step 1: Write the failing tests**

`test/jobs.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import type { JobRecord } from '../src/types';
import { listJobs, readJob, RetryableError, updateJob, waitForJob, writeJob, type PollState } from '../src/utils/jobs';
import { tmpDir } from './helpers/registry';

function rec(id: string, status: JobRecord['status'], submittedAt: string): JobRecord {
  return { id, provider: 'atlas', model: 'm', kind: 'image', output: '/tmp/o.png', submittedAt, status };
}

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

beforeEach(() => {
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});

describe('records', () => {
  test('write, read, update', () => {
    writeJob(rec('abc', 'pending', '2026-10-04T10:00:00Z'));
    expect(readJob('abc')?.status).toBe('pending');
    updateJob('abc', { status: 'completed', outputs: ['/tmp/o.png'] });
    expect(readJob('abc')?.outputs).toEqual(['/tmp/o.png']);
    expect(readJob('missing')).toBeUndefined();
  });

  test('ids with slashes are stored safely', () => {
    writeJob(rec('models/veo/operations/xyz', 'pending', '2026-10-04T10:00:00Z'));
    expect(readJob('models/veo/operations/xyz')?.id).toBe('models/veo/operations/xyz');
  });

  test('lists pending first, then newest', () => {
    writeJob(rec('old-done', 'completed', '2026-10-01T00:00:00Z'));
    writeJob(rec('new-done', 'completed', '2026-10-03T00:00:00Z'));
    writeJob(rec('pending', 'pending', '2026-09-01T00:00:00Z'));
    expect(listJobs().map((j) => j.id)).toEqual(['pending', 'new-done', 'old-done']);
  });

  test('writes atomically (no temp files left, valid JSON)', () => {
    for (let i = 0; i < 20; i++) writeJob(rec('race', 'pending', `2026-10-04T10:00:${String(i).padStart(2, '0')}Z`));
    const files = fs.readdirSync(process.env.GENERATE_JOBS_DIR!);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readJob('race')?.submittedAt).toBe('2026-10-04T10:00:19Z');
  });
});

describe('waitForJob', () => {
  test('returns the terminal state after processing polls', async () => {
    const clock = fakeClock();
    const states: PollState[] = [{ status: 'processing' }, { status: 'processing' }, { status: 'completed', urls: ['u'] }];
    const result = await waitForJob(async () => states.shift()!, { waitSeconds: 60, intervalMs: 2000, ...clock });
    expect(result).toEqual({ status: 'completed', urls: ['u'] });
    expect(clock.sleeps).toEqual([2000, 2000]);
  });

  test('backs off on retryable errors, capped, then resets', async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await waitForJob(
      async () => {
        n++;
        if (n <= 2) throw new RetryableError('429');
        if (n === 3) return { status: 'processing' };
        return { status: 'failed', code: 1039, message: 'x' };
      },
      { waitSeconds: 600, intervalMs: 2000, ...clock }
    );
    expect(result.status).toBe('failed');
    expect(clock.sleeps).toEqual([4000, 8000, 2000]);
  });

  test('network TypeErrors are retryable', async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await waitForJob(
      async () => {
        if (n++ === 0) throw new TypeError('fetch failed');
        return { status: 'completed', urls: [] };
      },
      { waitSeconds: 60, intervalMs: 2000, ...clock }
    );
    expect(result.status).toBe('completed');
  });

  test('times out without sleeping past the deadline', async () => {
    const clock = fakeClock();
    const result = await waitForJob(async () => ({ status: 'processing' }), { waitSeconds: 5, intervalMs: 2000, ...clock });
    expect(result).toEqual({ status: 'timeout' });
    expect(clock.now()).toBeLessThanOrEqual(5000);
  });

  test('non-retryable errors propagate', async () => {
    const clock = fakeClock();
    await expect(waitForJob(async () => { throw new Error('401 unauthorized'); }, { waitSeconds: 60, intervalMs: 2000, ...clock })).rejects.toThrow('401');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/jobs.test.ts`
Expected: FAIL with "Cannot find module '../src/utils/jobs'".

- [ ] **Step 3: Implement `src/utils/jobs.ts`**

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { JobRecord, ModelKind } from '../types';

export const DEFAULT_WAIT_SECONDS: Record<ModelKind, number> = { image: 120, video: 600, audio: 300 };
export const POLL_INTERVAL_MS: Record<ModelKind, number> = { image: 2000, video: 5000, audio: 5000 };
const MAX_BACKOFF_MS = 30000;

export function jobsDir(): string {
  const override = process.env.GENERATE_JOBS_DIR?.trim();
  if (override) return override;
  const cache = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(cache, 'generate', 'jobs');
}

function jobPath(id: string): string {
  return path.join(jobsDir(), `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/** Write via temp file + rename so concurrent readers never see a partial record. */
export function writeJob(rec: JobRecord): void {
  fs.mkdirSync(jobsDir(), { recursive: true });
  const target = jobPath(rec.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, target);
}

export function readJob(id: string): JobRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')) as JobRecord;
  } catch {
    return undefined;
  }
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord {
  const current = readJob(id);
  if (!current) throw new Error(`No job record for ${id}`);
  const next = { ...current, ...patch };
  writeJob(next);
  return next;
}

export function listJobs(): JobRecord[] {
  const dir = jobsDir();
  if (!fs.existsSync(dir)) return [];
  const records = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as JobRecord;
      } catch {
        return undefined;
      }
    })
    .filter((r): r is JobRecord => r !== undefined);
  return records.sort(
    (a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.submittedAt.localeCompare(a.submittedAt)
  );
}

export type PollState =
  | { status: 'processing' }
  | { status: 'completed'; urls: string[] }
  | { status: 'failed'; code?: number | string; message: string };

/** Thrown by a poller when the poll may simply be repeated (429, transient 5xx). */
export class RetryableError extends Error {}

export interface WaitOptions {
  waitSeconds: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (status: string) => void;
}

/**
 * Poll until a terminal state or the deadline. Only polls are repeated; this
 * function never submits anything. Retryable errors and network TypeErrors
 * double the delay (capped at 30 s); any other error propagates.
 */
export async function waitForJob(poll: () => Promise<PollState>, o: WaitOptions): Promise<PollState | { status: 'timeout' }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const start = now();
  const deadline = start + o.waitSeconds * 1000;
  let delay = o.intervalMs;

  for (;;) {
    try {
      const state = await poll();
      if (state.status !== 'processing') return state;
      delay = o.intervalMs;
      o.onProgress?.(`Still running (${Math.round((now() - start) / 1000)}s elapsed)...`);
    } catch (err) {
      if (!(err instanceof RetryableError) && !(err instanceof TypeError)) throw err;
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      o.onProgress?.(`Polling paused (${(err as Error).message}); retrying in ${Math.round(delay / 1000)}s...`);
    }
    if (now() + delay > deadline) return { status: 'timeout' };
    await sleep(delay);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/jobs.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/jobs.ts test/jobs.test.ts
git commit -m "feat(jobs): durable job records and a poll loop that never resubmits"
```

---

### Task 4: Veo on the job layer, with resume

**Files:**
- Modify: `src/providers/google.ts` (constructor, `generateVideo`, new `waitVeo`, `saveVeoVideo`, `resume`, exported `veoPollState`)
- Test: `test/google-veo.test.ts`

**Interfaces:**
- Consumes: `writeJob`, `updateJob`, `waitForJob`, `RetryableError`, `DEFAULT_WAIT_SECONDS`, `POLL_INTERVAL_MS`, `PollState` (Task 3); `JobRecord` (Task 1).
- Produces: `veoPollState(op: { done?: boolean; error?: Record<string, unknown> }): PollState`; `new GoogleProvider(client?: GoogleGenAI)`; `GoogleProvider.resume(record, opts)`.

- [ ] **Step 1: Write the failing tests**

`test/google-veo.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import type { GoogleGenAI } from '@google/genai';
import { GoogleProvider, veoPollState } from '../src/providers/google';
import { readJob, writeJob } from '../src/utils/jobs';
import { tmpDir, useRealRegistry } from './helpers/registry';

function fakeClient(sequence: Array<Record<string, unknown>>) {
  const calls = { generate: 0, poll: 0 };
  const client = {
    models: {
      generateVideos: async () => {
        calls.generate++;
        return { name: 'models/veo/operations/op1', done: false };
      },
    },
    operations: {
      getVideosOperation: async () => {
        calls.poll++;
        return sequence.length > 1 ? sequence.shift()! : sequence[0];
      },
    },
    files: { download: async () => { throw new Error('not used: bytes are inline'); } },
  };
  return { client: client as unknown as GoogleGenAI, calls };
}

beforeEach(() => {
  useRealRegistry();
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});
afterAll(useRealRegistry);

describe('veoPollState', () => {
  test('maps operation states', () => {
    expect(veoPollState({ done: false })).toEqual({ status: 'processing' });
    expect(veoPollState({ done: true, error: { message: 'blocked' } })).toEqual({ status: 'failed', message: '{"message":"blocked"}' });
    expect(veoPollState({ done: true })).toEqual({ status: 'completed', urls: [] });
  });
});

describe('Veo jobs', () => {
  test('a slow job is recorded and returned as pending, not failed', async () => {
    const { client, calls } = fakeClient([{ done: false }]);
    const out = path.join(tmpDir(), 'v.mp4');
    const result = await new GoogleProvider(client).generate({ model: 'veo-3.1-lite', prompt: 'rain', output: out, waitSeconds: 0 });
    expect(result.success).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.jobId).toBe('models/veo/operations/op1');
    expect(readJob('models/veo/operations/op1')?.status).toBe('pending');
    expect(calls.generate).toBe(1);
  });

  test('resume finishes the recorded job and never calls generate', async () => {
    const video = Buffer.from('fake-mp4').toString('base64');
    const { client, calls } = fakeClient([{ done: true, response: { generatedVideos: [{ video: { videoBytes: video } }] } }]);
    const out = path.join(tmpDir(), 'v.mp4');
    writeJob({ id: 'models/veo/operations/op2', provider: 'google', model: 'veo-3.1-lite', kind: 'video', output: out, submittedAt: new Date().toISOString(), status: 'pending' });
    const result = await new GoogleProvider(client).resume(readJob('models/veo/operations/op2')!, {});
    expect(result.success).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toBe('fake-mp4');
    expect(readJob('models/veo/operations/op2')?.status).toBe('completed');
    expect(calls.generate).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/google-veo.test.ts`
Expected: FAIL (`veoPollState` not exported; constructor ignores the client; no `resume`).

- [ ] **Step 3: Refactor `src/providers/google.ts`**

Imports, at the top:

```ts
import { GenerateVideosOperation, GoogleGenAI } from '@google/genai';
import type { GenerateOptions, GenerationResult, JobRecord, Model } from '../types';
import { DEFAULT_WAIT_SECONDS, POLL_INTERVAL_MS, RetryableError, updateJob, waitForJob, writeJob, type PollState } from '../utils/jobs';
```

Add above the class:

```ts
export function veoPollState(op: { done?: boolean; error?: Record<string, unknown> }): PollState {
  if (!op.done) return { status: 'processing' };
  if (op.error) return { status: 'failed', message: JSON.stringify(op.error) };
  return { status: 'completed', urls: [] };
}
```

Constructor: change `constructor() {` to `constructor(client?: GoogleGenAI) {` and make its first lines:

```ts
    super();
    if (client) {
      this.client = client;
      return;
    }
```

In `generateVideo`, keep everything up to and including the `generateVideos(...)` call, then replace the poll loop and everything after it, up to the `catch`, with:

```ts
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
        request: { prompt_sent: options.prompt, seed: options.seed, params: config, refs: (options.referenceImages ?? []).slice(0, 1).map((p) => ({ role: 'start', path: p })), draft: Boolean(options.draft) },
      };
      writeJob(record);
      if (options.noWait) return { success: false, pending: true, jobId: record.id, providerModelId: modelName, request: record.request };
      return await this.waitVeo(operation, record, options);
```

Add these methods to the class:

```ts
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
```

Delete the old `startTime` usage only if `tsc` reports it unused; keep the `catch` block's error mapping as is.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test test/google-veo.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/providers/google.ts test/google-veo.test.ts
git commit -m "fix(veo): record jobs and resume them instead of discarding slow operations"
```

---

### Task 5: Atlas HTTP client

**Files:**
- Create: `src/providers/atlas-client.ts`
- Modify: `src/utils/download.ts` (add `extFor`, `outputPathFor`)
- Test: `test/atlas-client.test.ts`

**Interfaces:**
- Consumes: `PollState`, `RetryableError` (Task 3); `ModelKind` (Task 1).
- Produces: `ATLAS_BASE`; `type FetchLike = typeof fetch`; `class AtlasError extends Error { status?: number; code?: number | string }`; `class AtlasClient { constructor(apiKey: string, fetchImpl?: FetchLike, base?: string); submit(kind: ModelKind, body: Record<string, unknown>): Promise<string>; poll(id: string): Promise<PollState>; upload(filePath: string): Promise<string>; calculate(body: Record<string, unknown>): Promise<number>; fetchBytes(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> }`; `parseQuote(json: unknown): number`; `QUOTE_PATHS: string[]`; `describeAtlasError(code: number | string | undefined, message: string): string`; `extFor(url: string, contentType: string): string`; `outputPathFor(requested: string, index: number, count: number, ext: string): string`.

- [ ] **Step 1: Write the failing tests**

`test/atlas-client.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { AtlasClient, AtlasError, describeAtlasError, parseQuote } from '../src/providers/atlas-client';
import { RetryableError } from '../src/utils/jobs';
import { extFor, outputPathFor } from '../src/utils/download';
import { tmpDir } from './helpers/registry';

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('submit', () => {
  test('posts once to the kind endpoint and returns data.id', async () => {
    const { impl, calls } = fakeFetch([json({ data: { id: 'p1' } })]);
    const id = await new AtlasClient('k', impl).submit('video', { model: 'm', prompt: 'p' });
    expect(id).toBe('p1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.atlascloud.ai/api/v1/model/generateVideo');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ model: 'm', prompt: 'p' });
  });

  test('an HTTP error is reported once and not retried', async () => {
    const { impl, calls } = fakeFetch([json({ message: 'bad model' }, 400)]);
    await expect(new AtlasClient('k', impl).submit('image', { model: 'x' })).rejects.toBeInstanceOf(AtlasError);
    expect(calls).toHaveLength(1);
  });

  test('a network error says the submission state is unknown, and is not retried', async () => {
    const { impl, calls } = fakeFetch([new TypeError('socket hang up')]);
    await expect(new AtlasClient('k', impl).submit('image', { model: 'x' })).rejects.toThrow(/submission state unknown/);
    expect(calls).toHaveLength(1);
  });
});

describe('poll', () => {
  test('maps statuses', async () => {
    const { impl } = fakeFetch([
      json({ data: { id: 'p', status: 'processing', outputs: [] } }),
      json({ data: { id: 'p', status: 'completed', outputs: ['https://x/a.png'] } }),
      json({ data: { id: 'p', status: 'failed', outputs: [], error: 'nsfw', error_code: 1039 } }),
    ]);
    const c = new AtlasClient('k', impl);
    expect(await c.poll('p')).toEqual({ status: 'processing' });
    expect(await c.poll('p')).toEqual({ status: 'completed', urls: ['https://x/a.png'] });
    expect(await c.poll('p')).toEqual({ status: 'failed', code: 1039, message: 'nsfw' });
  });

  test('429 and 5xx are retryable; 401 is not', async () => {
    const { impl } = fakeFetch([json({}, 429), json({}, 503), json({}, 401)]);
    const c = new AtlasClient('k', impl);
    await expect(c.poll('p')).rejects.toBeInstanceOf(RetryableError);
    await expect(c.poll('p')).rejects.toBeInstanceOf(RetryableError);
    await expect(c.poll('p')).rejects.toBeInstanceOf(AtlasError);
  });
});

describe('upload and calculate', () => {
  test('upload sends multipart and accepts {url} or {data:{url}}', async () => {
    const file = path.join(tmpDir(), 'a.png');
    fs.writeFileSync(file, 'png');
    const { impl, calls } = fakeFetch([json({ url: 'https://t/1' }), json({ data: { url: 'https://t/2' } }), json({ ok: true })]);
    const c = new AtlasClient('k', impl);
    expect(await c.upload(file)).toBe('https://t/1');
    expect(calls[0].init?.body).toBeInstanceOf(FormData);
    expect(await c.upload(file)).toBe('https://t/2');
    await expect(c.upload(file)).rejects.toThrow(/no URL/);
  });

  test('parseQuote reads known shapes and refuses unknown ones', () => {
    expect(parseQuote({ data: { price: 0.04 } })).toBe(0.04);
    expect(() => parseQuote({ data: { something: 1 } })).toThrow(/Unrecognised \/calculate response/);
  });

  test('moderation code gets a plain message', () => {
    expect(describeAtlasError(1039, 'x')).toBe('rejected by content moderation (Atlas error 1039)');
    expect(describeAtlasError(undefined, 'bad resolution')).toBe('bad resolution');
  });
});

describe('output naming', () => {
  test('extension from URL, else content type', () => {
    expect(extFor('https://x/a/b.JPG?sig=1', 'image/png')).toBe('jpg');
    expect(extFor('https://x/a/b', 'video/mp4')).toBe('mp4');
    expect(extFor('https://x/a/b', 'audio/mpeg')).toBe('mp3');
    expect(extFor('https://x/a/b', 'application/octet-stream')).toBe('bin');
  });
  test('paths keep the stem and number multiple outputs', () => {
    expect(outputPathFor('/o/out.png', 0, 1, 'jpg')).toBe('/o/out.jpg');
    expect(outputPathFor('/o/out.png', 1, 3, 'png')).toBe('/o/out-2.png');
    expect(outputPathFor('/o/out', 0, 1, 'mp4')).toBe('/o/out.mp4');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/atlas-client.test.ts`
Expected: FAIL with "Cannot find module '../src/providers/atlas-client'".

- [ ] **Step 3: Add `extFor` and `outputPathFor` to `src/utils/download.ts`**

Append:

```ts
const KNOWN_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'flac', 'ogg'];
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
};

/** File extension for a served output: the URL's own extension, else the content type. */
export function extFor(url: string, contentType: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // not a URL; use as-is
  }
  const fromUrl = pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (fromUrl && KNOWN_EXT.includes(fromUrl)) return fromUrl === 'jpeg' ? 'jpg' : fromUrl;
  return EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

/** Requested path with the served extension; "-N" suffix when there are several outputs. */
export function outputPathFor(requested: string, index: number, count: number, ext: string): string {
  const stem = requested.replace(/\.[A-Za-z0-9]+$/, '');
  return `${stem}${count > 1 ? `-${index + 1}` : ''}.${ext}`;
}
```

- [ ] **Step 4: Implement `src/providers/atlas-client.ts`**

```ts
import path from 'path';
import type { ModelKind } from '../types';
import { RetryableError, type PollState } from '../utils/jobs';

export const ATLAS_BASE = 'https://api.atlascloud.ai/api/v1';
export type FetchLike = typeof fetch;

export class AtlasError extends Error {
  constructor(message: string, public status?: number, public code?: number | string) {
    super(message);
  }
}

const SUBMIT_PATH: Record<ModelKind, string> = {
  image: '/model/generateImage',
  video: '/model/generateVideo',
  audio: '/model/generateAudio',
};

/**
 * Dotted paths tried, in order, to read the price from POST /model/calculate.
 * Task 10 pins the first entry to the shape the live endpoint returns.
 */
export const QUOTE_PATHS = ['data.price', 'data.total_price', 'data.cost', 'data.amount', 'price'];

function dig(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function parseQuote(json: unknown): number {
  for (const p of QUOTE_PATHS) {
    const v = dig(json, p);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  throw new Error(`Unrecognised /calculate response: ${JSON.stringify(json).slice(0, 300)}`);
}

const ERROR_TEXT: Record<string, string> = {
  '1039': 'rejected by content moderation',
};

export function describeAtlasError(code: number | string | undefined, message: string): string {
  const known = code !== undefined ? ERROR_TEXT[String(code)] : undefined;
  return known ? `${known} (Atlas error ${code})` : message;
}

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export class AtlasClient {
  constructor(private apiKey: string, private fetchImpl: FetchLike = fetch, private base = ATLAS_BASE) {}

  private headers(json: boolean): Record<string, string> {
    return json ? { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' } : { Authorization: `Bearer ${this.apiKey}` };
  }

  /** Sent exactly once. Any failure is reported, never retried. */
  async submit(kind: ModelKind, body: Record<string, unknown>): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${SUBMIT_PATH[kind]}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    } catch (err) {
      throw new AtlasError(
        `Atlas submission state unknown (${(err as Error).message}). The job may have been created and billed; check \`generate --jobs\` and the Atlas dashboard before retrying.`
      );
    }
    if (!res.ok) throw new AtlasError(`Atlas rejected the request (HTTP ${res.status}): ${await bodyText(res)}`, res.status);
    const json = (await res.json()) as { data?: { id?: string } };
    const id = json.data?.id;
    if (!id) throw new AtlasError(`Atlas accepted the request but returned no prediction id: ${JSON.stringify(json).slice(0, 300)}`);
    return id;
  }

  async poll(id: string): Promise<PollState> {
    const res = await this.fetchImpl(`${this.base}/model/prediction/${encodeURIComponent(id)}`, { headers: this.headers(false) });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
    if (!res.ok) throw new AtlasError(`Atlas poll failed (HTTP ${res.status}): ${await bodyText(res)}`, res.status);
    const json = (await res.json()) as { data?: { status?: string; outputs?: string[]; error?: string | null; error_code?: number | string } };
    const data = json.data ?? {};
    if (data.status === 'completed') return { status: 'completed', urls: data.outputs ?? [] };
    if (data.status === 'failed' || data.status === 'timeout') {
      return { status: 'failed', code: data.error_code, message: data.error ?? `Atlas job ${data.status}` };
    }
    return { status: 'processing' };
  }

  async upload(filePath: string): Promise<string> {
    const form = new FormData();
    form.append('file', Bun.file(filePath), path.basename(filePath));
    const res = await this.fetchImpl(`${this.base}/model/uploadMedia`, { method: 'POST', headers: this.headers(false), body: form });
    if (!res.ok) throw new AtlasError(`Atlas upload failed (HTTP ${res.status}): ${await bodyText(res)}`, res.status);
    const json = (await res.json()) as { url?: string; data?: { url?: string; download_url?: string } };
    const url = json.url ?? json.data?.url ?? json.data?.download_url;
    if (!url) throw new AtlasError(`Atlas upload returned no URL: ${JSON.stringify(json).slice(0, 300)}`);
    return url;
  }

  /** Free; creates no task. */
  async calculate(body: Record<string, unknown>): Promise<number> {
    const res = await this.fetchImpl(`${this.base}/model/calculate`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    if (!res.ok) throw new AtlasError(`Atlas price check failed (HTTP ${res.status}): ${await bodyText(res)}`, res.status);
    return parseQuote(await res.json());
  }

  async fetchBytes(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new AtlasError(`Download failed (HTTP ${res.status}) for ${url}`, res.status);
    return { bytes: await res.arrayBuffer(), contentType: res.headers.get('content-type') ?? '' };
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test test/atlas-client.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/providers/atlas-client.ts src/utils/download.ts test/atlas-client.test.ts
git commit -m "feat(atlas): HTTP client with single-shot submit, retryable polling, upload, price check"
```

---

### Task 6: Atlas provider

**Files:**
- Create: `src/providers/atlas.ts`
- Modify: `src/providers/index.ts` (register `atlas`)
- Test: `test/atlas.test.ts`

**Interfaces:**
- Consumes: `AtlasClient`, `describeAtlasError` (Task 5); `extFor`, `outputPathFor` (Task 5); jobs API (Task 3); `renderRefLabels` (Task 2); `getModelSpec(model, 'atlas')`, `modelsForProvider` (Task 1); `resolveApiKey` from `src/utils/keychain.ts`.
- Produces: `buildAtlasRequest(spec: ModelSpec, options: GenerateOptions, uploaded: { legacy: string[]; refs: Array<RoleRef & { url: string }> }): { modelId: string; body: Record<string, unknown>; promptSent: string }`; `class AtlasProvider implements ImageProvider` with `constructor(client?: AtlasClient)`, `generate`, `resume`, `quote`.

- [ ] **Step 1: Write the failing tests**

`test/atlas.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { getModelSpec } from '../src/config/models';
import { AtlasClient } from '../src/providers/atlas-client';
import { AtlasProvider, buildAtlasRequest } from '../src/providers/atlas';
import { readJob } from '../src/utils/jobs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});
afterAll(useRealRegistry);

describe('buildAtlasRequest', () => {
  test('text-to-image uses the base id and mapped fields', () => {
    const spec = getModelSpec('img-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'img-shared', prompt: 'cat', aspectRatio: '1:1', size: '2K', seed: 7 }, { legacy: [], refs: [] });
    expect(r.modelId).toBe('vendor/img/text-to-image');
    expect(r.body).toEqual({ model: 'vendor/img/text-to-image', prompt: 'cat', aspect_ratio: '1:1', resolution: '2k', seed: 7 });
  });

  test('legacy -r on an image model switches to the edit id and fills images', () => {
    const spec = getModelSpec('img-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'img-shared', prompt: 'fix' }, { legacy: ['https://u/1', 'https://u/2'], refs: [] });
    expect(r.modelId).toBe('vendor/img/edit');
    expect(r.body.images).toEqual(['https://u/1', 'https://u/2']);
  });

  test('role refs on an image model are labelled in the prompt in send order', () => {
    const spec = getModelSpec('img-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'img-shared', prompt: 'portrait' }, { legacy: [], refs: [{ role: 'identity', source: 'a', url: 'https://u/a', note: 'face only' }] });
    expect(r.body.images).toEqual(['https://u/a']);
    expect(r.promptSent).toBe('portrait\n\n@Image1: identity reference: keep this person or character recognisably the same (face only).');
  });

  test('video start/end frames use i2v and frame fields', () => {
    const spec = getModelSpec('vid-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'vid-shared', prompt: 'walk', duration: 5 }, {
      legacy: [],
      refs: [{ role: 'start', source: 's', url: 'https://u/s' }, { role: 'end', source: 'e', url: 'https://u/e' }],
    });
    expect(r.modelId).toBe('vendor/vid/image-to-video');
    expect(r.body).toMatchObject({ image: 'https://u/s', end_image: 'https://u/e', duration: 5 });
  });

  test('video identity refs use r2v and reference_images', () => {
    const spec = getModelSpec('vid-shared', 'atlas');
    const r = buildAtlasRequest(spec, { model: 'vid-shared', prompt: 'talk' }, { legacy: [], refs: [{ role: 'identity', source: 'a', url: 'https://u/a' }] });
    expect(r.modelId).toBe('vendor/vid/reference-to-video');
    expect(r.body.reference_images).toEqual(['https://u/a']);
  });

  test('negative prompt: native field when mapped, folded otherwise; params override last', () => {
    const vid = buildAtlasRequest(getModelSpec('vid-shared', 'atlas'), { model: 'vid-shared', prompt: 'p', negativePrompt: 'blur', params: { sound: true, duration: 9 }, duration: 5 }, { legacy: [], refs: [] });
    expect(vid.body).toMatchObject({ negative_prompt: 'blur', sound: true, duration: 9 });
    const img = buildAtlasRequest(getModelSpec('img-shared', 'atlas'), { model: 'img-shared', prompt: 'p', negativePrompt: 'blur' }, { legacy: [], refs: [] });
    expect(img.promptSent).toBe('p\n\nAvoid: blur');
  });

  test('audio uses the mapped prompt field', () => {
    const r = buildAtlasRequest(getModelSpec('tts-only', 'atlas'), { model: 'tts-only', prompt: 'hello' }, { legacy: [], refs: [] });
    expect(r.body).toEqual({ model: 'vendor/tts', text: 'hello' });
  });
});

function scripted(responses: Response[]) {
  const posts: string[] = [];
  let pollsBeforeRecordCheck: (() => void) | undefined;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') posts.push(u);
    if (u.includes('/model/prediction/')) pollsBeforeRecordCheck?.();
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${u}`);
    return next;
  }) as typeof fetch;
  return { impl, posts, onFirstPoll: (fn: () => void) => { pollsBeforeRecordCheck = fn; } };
}

describe('AtlasProvider jobs', () => {
  test('submits once, records the job before polling, downloads with the served extension', async () => {
    const s = scripted([
      json({ data: { id: 'pred-1' } }),
      json({ data: { status: 'processing', outputs: [] } }),
      json({ data: { status: 'completed', outputs: ['https://cdn/x/result'] } }),
      new Response('JPEGBYTES', { headers: { 'content-type': 'image/jpeg' } }),
    ]);
    let recordAtFirstPoll: string | undefined;
    s.onFirstPoll(() => { recordAtFirstPoll ??= readJob('pred-1')?.status; });
    const out = path.join(tmpDir(), 'out.png');
    const result = await new AtlasProvider(new AtlasClient('k', s.impl)).generate({ model: 'img-shared', prompt: 'cat', output: out, waitSeconds: 30 });
    expect(recordAtFirstPoll).toBe('pending');
    expect(result.success).toBe(true);
    expect(result.outputs).toEqual([out.replace(/\.png$/, '.jpg')]);
    expect(fs.readFileSync(result.outputs![0], 'utf8')).toBe('JPEGBYTES');
    expect(readJob('pred-1')?.status).toBe('completed');
    expect(s.posts.filter((u) => u.includes('/generate'))).toHaveLength(1);
  });

  test('timeout leaves a pending record and returns pending', async () => {
    const s = scripted([json({ data: { id: 'pred-2' } }), json({ data: { status: 'processing' } })]);
    const result = await new AtlasProvider(new AtlasClient('k', s.impl)).generate({ model: 'img-shared', prompt: 'cat', output: path.join(tmpDir(), 'o.png'), waitSeconds: 0 });
    expect(result.pending).toBe(true);
    expect(result.jobId).toBe('pred-2');
    expect(readJob('pred-2')?.status).toBe('pending');
  });

  test('moderation failure is recorded with a plain message', async () => {
    const s = scripted([json({ data: { id: 'pred-3' } }), json({ data: { status: 'failed', error: 'x', error_code: 1039 } })]);
    const result = await new AtlasProvider(new AtlasClient('k', s.impl)).generate({ model: 'img-shared', prompt: 'cat', output: path.join(tmpDir(), 'o.png'), waitSeconds: 30 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('rejected by content moderation (Atlas error 1039)');
    expect(readJob('pred-3')?.status).toBe('failed');
  });

  test('quote uploads local refs once and calls /calculate, not /generate', async () => {
    const ref = path.join(tmpDir(), 'face.png');
    fs.writeFileSync(ref, 'png');
    const s = scripted([json({ url: 'https://t/face' }), json({ data: { price: 0.05 } })]);
    const usd = await new AtlasProvider(new AtlasClient('k', s.impl)).quote({ model: 'img-shared', prompt: 'p', refs: [{ role: 'identity', source: ref }] });
    expect(usd).toBe(0.05);
    expect(s.posts.some((u) => u.includes('/generate'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/atlas.test.ts`
Expected: FAIL with "Cannot find module '../src/providers/atlas'".

- [ ] **Step 3: Implement `src/providers/atlas.ts`**

```ts
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
```

- [ ] **Step 4: Register the provider**

In `src/providers/index.ts` add `import { AtlasProvider } from './atlas';`, add the switch case:

```ts
      case 'atlas':
        provider = new AtlasProvider();
        break;
```

and add `AtlasProvider` to the final `export { ... }` list.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test test/atlas.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/providers/atlas.ts src/providers/index.ts test/atlas.test.ts
git commit -m "feat(atlas): provider with role refs, uploads, recorded jobs, resume, and quotes"
```

---

### Task 7: Codex and Antigravity agent providers

**Files:**
- Create: `src/utils/staged-agent.ts`, `src/providers/codex.ts`, `src/providers/agy.ts`, `test/fixtures/stub-agent.sh`
- Modify: `src/providers/index.ts` (register `codex`, `agy`)
- Test: `test/agents.test.ts`

**Interfaces:**
- Consumes: `getModelSpec(model, 'codex' | 'agy')`, `modelsForProvider` (Task 1); `GenerateOptions`, `GenerationResult`, `RequestRecord` (Task 1).
- Produces: `makeStage(outputPath: string): { stageDir: string; stageFile: string }`; `buildAgentPrompt(o: { lead: string; primary?: string; refs: { path: string; label: string }[]; userPrompt: string; saveInstruction: string }): string`; `runAgent(cmd: string, args: string[], o: { cwd: string; stdin?: string; timeoutMs: number }): Promise<{ code: number; timedOut: boolean; stderrTail: string }>`; `finalizeStaged(stageFile: string, outputPath: string): Promise<string>`; `agentRefs(options: GenerateOptions): { primary?: string; refs: { path: string; label: string }[] }`; `CodexProvider`, `AgyProvider`.

- [ ] **Step 1: Create the stub agent**

`test/fixtures/stub-agent.sh` (then `chmod +x test/fixtures/stub-agent.sh`):

```bash
#!/bin/bash
# Test double for the codex and agy CLIs. Records its argv and cwd, then writes
# a 1x1 PNG where the prompt asked for it.
#   STUB_ARGS_FILE  where to append "cwd=<dir>" and one line per argument
#   STUB_MODE       codex (prompt on stdin, absolute path) | agy (--prompt, ./generated.png)
#   STUB_EXIT       exit code (default 0)
#   STUB_NO_FILE    if set, write nothing
#   STUB_SLEEP      seconds to sleep before acting
[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"
{ echo "cwd=$(pwd -P)"; for a in "$@"; do echo "$a"; done; } >> "${STUB_ARGS_FILE:-/dev/null}"
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
if [ "$STUB_MODE" = "codex" ]; then
  prompt="$(cat)"
  echo "$prompt" > "${STUB_ARGS_FILE:-/dev/null}.prompt"
  target="$(printf '%s\n' "$prompt" | sed -n 's/^Save the selected image as a PNG exactly to: //p' | head -1)"
else
  target="generated.png"
  for a in "$@"; do last="$a"; done
  echo "$last" > "${STUB_ARGS_FILE:-/dev/null}.prompt"
fi
[ -z "$STUB_NO_FILE" ] && printf '%s' "$PNG" | base64 -D > "$target"
exit "${STUB_EXIT:-0}"
```

- [ ] **Step 2: Write the failing tests**

`test/agents.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { AgyProvider } from '../src/providers/agy';
import { CodexProvider } from '../src/providers/codex';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

const STUB = path.resolve(import.meta.dir, 'fixtures/stub-agent.sh');
let argsFile: string;

beforeEach(() => {
  writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
  argsFile = path.join(tmpDir(), 'args.txt');
  process.env.STUB_ARGS_FILE = argsFile;
  process.env.GENERATE_CODEX_BIN = STUB;
  process.env.GENERATE_AGY_BIN = STUB;
  for (const k of ['STUB_EXIT', 'STUB_NO_FILE', 'STUB_SLEEP']) delete process.env[k];
});
afterAll(useRealRegistry);

const mime = (p: string) => Bun.spawnSync(['file', '--mime-type', '-b', p]).stdout.toString().trim();
const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.startsWith('.generate-agent-'));

describe('codex', () => {
  beforeEach(() => { process.env.STUB_MODE = 'codex'; });

  test('generates through a staged file and cleans up', async () => {
    const dir = tmpDir();
    const out = path.join(dir, 'o.png');
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'a lighthouse', output: out });
    expect(result.success).toBe(true);
    expect(mime(out)).toBe('image/png');
    expect(leftovers(dir)).toEqual([]);
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).toContain('exec');
    expect(args).toContain('workspace-write');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).not.toContain('--model');
  });

  test('converts to JPEG when asked', async () => {
    const out = path.join(tmpDir(), 'o.jpg');
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'x', output: out });
    expect(result.success).toBe(true);
    expect(mime(out)).toBe('image/jpeg');
  });

  test('resolves reference paths (spaces, relative) to absolute real paths', async () => {
    const dir = tmpDir();
    const primary = path.join(dir, 'old photo.png');
    const ref = path.join(dir, 'face ref.png');
    fs.writeFileSync(primary, 'x');
    fs.writeFileSync(ref, 'x');
    const rel = path.relative(process.cwd(), ref);
    await new CodexProvider().generate({ model: 'img-shared', prompt: 'restore', output: path.join(dir, 'o.png'), referenceImages: [primary], refs: [{ role: 'identity', source: rel, note: 'face of the man' }] });
    const prompt = fs.readFileSync(`${argsFile}.prompt`, 'utf8');
    expect(prompt).toContain(`Primary image file (edit target): ${primary}`);
    expect(prompt).toContain(`Reference image 1 (identity reference: face of the man; never composite it): ${ref}`);
  });

  test('missing staged file is an error, not a success', async () => {
    process.env.STUB_NO_FILE = '1';
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'x', output: path.join(tmpDir(), 'o.png') });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/without creating the image/);
  });

  test('nonzero exit is an error', async () => {
    process.env.STUB_EXIT = '3';
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'x', output: path.join(tmpDir(), 'o.png') });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exited with code 3/);
  });

  test('timeout kills the agent and says plan usage may be spent', async () => {
    process.env.STUB_SLEEP = '5';
    const result = await new CodexProvider().generate({ model: 'img-shared', prompt: 'x', output: path.join(tmpDir(), 'o.png'), waitSeconds: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out after 1s; the run may still have used plan usage/);
  });
});

describe('agy', () => {
  beforeEach(() => { process.env.STUB_MODE = 'agy'; });

  test('runs sandboxed in the stage directory and saves a relative file', async () => {
    const dir = tmpDir();
    const out = path.join(dir, 'o.png');
    const result = await new AgyProvider().generate({ model: 'agy-image', prompt: 'a lighthouse', output: out });
    expect(result.success).toBe(true);
    expect(mime(out)).toBe('image/png');
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(args).toContain('--sandbox');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toMatch(new RegExp(`cwd=${dir}/\\.generate-agent-`));
    expect(result.providerModelId).toBe('agy default agent model');
    expect(leftovers(dir)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `chmod +x test/fixtures/stub-agent.sh && bun test test/agents.test.ts`
Expected: FAIL with "Cannot find module '../src/providers/agy'".

- [ ] **Step 4: Implement `src/utils/staged-agent.ts`**

```ts
import fs from 'fs';
import path from 'path';
import type { GenerateOptions } from '../types';

export function makeStage(outputPath: string): { stageDir: string; stageFile: string } {
  const dir = path.dirname(path.resolve(outputPath));
  fs.mkdirSync(dir, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(fs.realpathSync(dir), '.generate-agent-'));
  return { stageDir, stageFile: path.join(stageDir, 'generated.png') };
}

const realpath = (p: string) => fs.realpathSync(path.resolve(p));

/** Primary edit target is the first untyped -r; everything else is a labelled reference. */
export function agentRefs(options: GenerateOptions): { primary?: string; refs: { path: string; label: string }[] } {
  const legacy = options.referenceImages ?? [];
  const primary = legacy[0] ? realpath(legacy[0]) : undefined;
  const refs = [
    ...legacy.slice(1).map((p) => ({ path: realpath(p), label: 'identity/color/detail only; never composite it' })),
    ...(options.refs ?? []).map((r) => ({
      path: realpath(r.source),
      label: `${r.role} reference${r.note ? `: ${r.note}` : ''}; never composite it`,
    })),
  ];
  return { primary, refs };
}

export function buildAgentPrompt(o: { lead: string; primary?: string; refs: { path: string; label: string }[]; userPrompt: string; saveInstruction: string }): string {
  const lines = [o.lead];
  if (o.primary) lines.push('Inspect the primary image with the image-viewing tool before editing it.', '', `Primary image file (edit target): ${o.primary}`);
  o.refs.forEach((r, i) => lines.push(`Reference image ${i + 1} (${r.label}): ${r.path}`));
  lines.push(
    '',
    'Instructions:',
    o.userPrompt,
    '',
    o.saveInstruction,
    'Do not create any other files. Do not overwrite or modify any input image. Work autonomously without asking questions.',
    'Before finishing, verify that the saved PNG exists, is non-empty, and is a valid image.'
  );
  return lines.join('\n');
}

export async function runAgent(cmd: string, args: string[], o: { cwd: string; stdin?: string; timeoutMs: number }): Promise<{ code: number; timedOut: boolean; stderrTail: string }> {
  const proc = Bun.spawn([cmd, ...args], { cwd: o.cwd, stdin: o.stdin !== undefined ? 'pipe' : 'ignore', stdout: 'ignore', stderr: 'pipe' });
  if (o.stdin !== undefined && proc.stdin) {
    proc.stdin.write(o.stdin);
    proc.stdin.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, o.timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  const stderr = await new Response(proc.stderr).text();
  return { code, timedOut, stderrTail: stderr.trim().split('\n').slice(-5).join('\n') };
}

const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Convert the staged PNG to the requested format and verify the real MIME type. */
export async function finalizeStaged(stageFile: string, outputPath: string): Promise<string> {
  if (!fs.existsSync(stageFile) || fs.statSync(stageFile).size === 0) {
    throw new Error('the agent finished without creating the image');
  }
  const ext = path.extname(outputPath).slice(1).toLowerCase() || 'png';
  const expected = MIME_BY_EXT[ext];
  if (!expected) throw new Error(`unsupported output format .${ext} (use png, jpg, or webp)`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (ext === 'png') {
    fs.copyFileSync(stageFile, outputPath);
  } else {
    const sipsFormat = ext === 'webp' ? undefined : 'jpeg';
    const sips = sipsFormat && Bun.which('sips') ? Bun.spawnSync(['sips', '-s', 'format', sipsFormat, stageFile, '--out', outputPath]) : undefined;
    if (!sips || sips.exitCode !== 0) {
      const magick = Bun.which('magick');
      if (!magick) throw new Error(`cannot convert to .${ext}: neither sips nor ImageMagick is available`);
      const r = Bun.spawnSync([magick, stageFile, outputPath]);
      if (r.exitCode !== 0) throw new Error(`ImageMagick failed to convert to .${ext}`);
    }
  }
  const actual = Bun.spawnSync(['file', '--mime-type', '-b', outputPath]).stdout.toString().trim();
  if (actual !== expected) throw new Error(`output is ${actual}, expected ${expected}`);
  return outputPath;
}
```

- [ ] **Step 5: Implement `src/providers/codex.ts`**

```ts
import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { getModelSpec, modelsForProvider } from '../config/models';
import { agentRefs, buildAgentPrompt, finalizeStaged, makeStage, runAgent } from '../utils/staged-agent';

export class CodexProvider extends BaseProvider {
  name = 'Codex';
  models: Model[] = modelsForProvider('codex');

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const spec = getModelSpec(options.model, 'codex');
    const bin = process.env.GENERATE_CODEX_BIN?.trim() || 'codex';
    if (!Bun.which(bin)) return { success: false, error: 'codex CLI not found in PATH. Install it and run `codex login`.' };

    const output = path.resolve(options.output ?? DEFAULT_OPTIONS.output);
    const timeoutS = options.waitSeconds ?? spec.timeout_seconds ?? 600;
    let stage: { stageDir: string; stageFile: string } | undefined;
    try {
      const { primary, refs } = agentRefs(options);
      stage = makeStage(output);
      const prompt = buildAgentPrompt({
        lead: primary ? 'Use $imagegen to edit the image at the local file path below.' : 'Use $imagegen to generate an image.',
        primary,
        refs,
        userPrompt: options.prompt,
        saveInstruction: `Save the selected image as a PNG exactly to: ${stage.stageFile}`,
      });
      const args = [
        'exec',
        '--ephemeral',
        ...(spec.agent_model ? ['--model', spec.agent_model] : []),
        '--config',
        `model_reasoning_effort="${spec.reasoning_effort ?? 'high'}"`,
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        '--cd',
        path.dirname(stage.stageDir),
      ];
      options.onProgress?.('Codex is generating (agentic; this can take a few minutes)...');
      const run = await runAgent(bin, args, { cwd: path.dirname(stage.stageDir), stdin: prompt, timeoutMs: timeoutS * 1000 });
      if (run.timedOut) return { success: false, error: `Codex timed out after ${timeoutS}s; the run may still have used plan usage.` };
      if (run.code !== 0) return { success: false, error: `Codex exited with code ${run.code}${run.stderrTail ? `: ${run.stderrTail}` : ''}` };
      const final = await finalizeStaged(stage.stageFile, output);
      return {
        success: true,
        outputPath: final,
        outputs: [final],
        providerModelId: spec.id,
        request: { prompt_sent: prompt, params: { reasoning_effort: spec.reasoning_effort ?? 'high', agent_model: spec.agent_model ?? 'codex default' }, refs: refs.map((r) => ({ role: 'reference', path: r.path, note: r.label })), draft: false },
      };
    } catch (err) {
      return { success: false, error: `Codex: ${(err as Error).message}` };
    } finally {
      if (stage) fs.rmSync(stage.stageDir, { recursive: true, force: true });
    }
  }
}
```

The error from `finalizeStaged` reads "Codex: the agent finished without creating the image", which the test matches with `/without creating the image/`.

- [ ] **Step 6: Implement `src/providers/agy.ts`**

```ts
import fs from 'fs';
import path from 'path';
import { BaseProvider } from './base';
import type { GenerateOptions, GenerationResult, Model } from '../types';
import { DEFAULT_OPTIONS } from '../types';
import { getModelSpec, modelsForProvider } from '../config/models';
import { agentRefs, buildAgentPrompt, finalizeStaged, makeStage, runAgent } from '../utils/staged-agent';

/**
 * Antigravity CLI. Runs with the stage directory as its working directory and
 * saves a relative generated.png: a 2026-10-04 spike lost about half its run
 * time probing sandbox write access and confusing /tmp with /private/tmp when
 * given an absolute path elsewhere. --sandbox is mandatory because permissions
 * are skipped.
 */
export class AgyProvider extends BaseProvider {
  name = 'Antigravity';
  models: Model[] = modelsForProvider('agy');

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const spec = getModelSpec(options.model, 'agy');
    const bin = process.env.GENERATE_AGY_BIN?.trim() || 'agy';
    if (!Bun.which(bin)) return { success: false, error: 'agy CLI not found in PATH.' };

    const output = path.resolve(options.output ?? DEFAULT_OPTIONS.output);
    const timeoutS = options.waitSeconds ?? spec.timeout_seconds ?? 600;
    let stage: { stageDir: string; stageFile: string } | undefined;
    try {
      const { primary, refs } = agentRefs(options);
      stage = makeStage(output);
      const prompt = buildAgentPrompt({
        lead: primary ? 'Edit the image at the local file path below.' : 'Generate an image.',
        primary,
        refs,
        userPrompt: options.prompt,
        saveInstruction: `Save the selected image as a PNG named generated.png in the current working directory (${stage.stageDir}).`,
      });
      const args = ['--dangerously-skip-permissions', '--sandbox', '--effort', spec.reasoning_effort ?? 'high', '--prompt', prompt];
      options.onProgress?.('Antigravity is generating (agentic; this can take a few minutes)...');
      const run = await runAgent(bin, args, { cwd: stage.stageDir, timeoutMs: timeoutS * 1000 });
      if (run.timedOut) return { success: false, error: `agy timed out after ${timeoutS}s; the run may still have used plan usage.` };
      if (run.code !== 0) return { success: false, error: `agy exited with code ${run.code}${run.stderrTail ? `: ${run.stderrTail}` : ''}` };
      const final = await finalizeStaged(stage.stageFile, output);
      return {
        success: true,
        outputPath: final,
        outputs: [final],
        providerModelId: spec.id,
        request: { prompt_sent: prompt, params: { effort: spec.reasoning_effort ?? 'high' }, refs: refs.map((r) => ({ role: 'reference', path: r.path, note: r.label })), draft: false },
      };
    } catch (err) {
      return { success: false, error: `agy: ${(err as Error).message}` };
    } finally {
      if (stage) fs.rmSync(stage.stageDir, { recursive: true, force: true });
    }
  }
}
```

- [ ] **Step 7: Register both providers**

In `src/providers/index.ts` add imports `import { CodexProvider } from './codex';` and `import { AgyProvider } from './agy';`, the cases:

```ts
      case 'codex':
        provider = new CodexProvider();
        break;
      case 'agy':
        provider = new AgyProvider();
        break;
```

and add both to the export list.

- [ ] **Step 8: Run tests and typecheck**

Run: `bun test test/agents.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/utils/staged-agent.ts src/providers/codex.ts src/providers/agy.ts src/providers/index.ts test/agents.test.ts test/fixtures/stub-agent.sh
git commit -m "feat(agents): Codex and Antigravity plan-billed image providers with file-based success"
```

---

### Task 8: Orchestration, cost, and provenance

**Files:**
- Create: `src/cost.ts`, `src/run.ts`, `src/utils/provenance.ts`
- Test: `test/run.test.ts`, `test/provenance.test.ts`

**Interfaces:**
- Consumes: `resolveModel`, `selectSpec`, `NoBillingPathError`, `BillingFilter` (Task 1); `validateRefs` (Task 2); `readJob` (Task 3); `ImageProvider.quote`/`resume` (Task 1).
- Produces: `interface PriceInfo { usd: number; source: 'quote' | 'list-price'; unit?: string }`; `priceFor(spec: ModelSpec, provider: ImageProvider, options: GenerateOptions): Promise<PriceInfo | undefined>`; `type ExitCode = 0 | 1 | 2 | 75`; `interface ResultJson`; `interface RunRequest`; `interface RunDeps`; `run(req: RunRequest, deps: RunDeps): Promise<ResultJson>`; `resumeJob(id: string, opts: { waitSeconds?: number; onProgress?: (s: string) => void }, deps: RunDeps): Promise<ResultJson>`; `draftPath(output: string): string`; `stampProvenance(paths: string[], json: ResultJson): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`test/run.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { GenerateOptions, GenerationResult, ImageProvider, JobRecord, Provider } from '../src/types';
import { draftPath, resumeJob, run, type RunDeps, type RunRequest } from '../src/run';
import { writeJob } from '../src/utils/jobs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

class FakeProvider implements ImageProvider {
  name = 'fake';
  models = [];
  calls: { generate: GenerateOptions[]; quote: number; resume: number } = { generate: [], quote: 0, resume: 0 };
  constructor(private result: GenerationResult = { success: true, outputPath: '/tmp/x.png' }, private price?: number) {}
  async generate(o: GenerateOptions) { this.calls.generate.push(o); return this.result; }
  async resume() { this.calls.resume++; return this.result; }
  quote?: (o: GenerateOptions) => Promise<number>;
  withQuote() { this.quote = async () => { this.calls.quote++; return this.price!; }; return this; }
}

function deps(map: Partial<Record<Provider, FakeProvider>>): RunDeps {
  return { getProvider: (p) => { const f = map[p]; if (!f) throw new Error(`no fake for ${p}`); return f; } };
}

const req = (over: Partial<RunRequest> = {}, opts: Partial<GenerateOptions> = {}): RunRequest => ({
  modelInput: 'img-shared',
  billing: 'any',
  draft: false,
  quoteOnly: false,
  ...over,
  options: { prompt: 'p', output: '/tmp/o.png', ...opts },
});

beforeEach(() => {
  writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
  process.env.GENERATE_JOBS_DIR = tmpDir('gen-jobs-');
});
afterAll(useRealRegistry);

describe('run', () => {
  test('routes to the active provider and reports billing', async () => {
    const google = new FakeProvider();
    const json = await run(req(), deps({ google }));
    expect(json).toMatchObject({ ok: true, exit_code: 0, provider: 'google', billing: 'metered', outputs: ['/tmp/x.png'] });
  });

  test('--billing plan routes to the plan offer', async () => {
    const codex = new FakeProvider();
    const json = await run(req({ billing: 'plan' }), deps({ codex }));
    expect(json).toMatchObject({ ok: true, provider: 'codex', billing: 'plan', agentic: true });
  });

  test('--billing plan with no plan path is rejected before anything is sent', async () => {
    const json = await run(req({ modelInput: 'vid-shared', billing: 'plan' }), deps({}));
    expect(json.exit_code).toBe(2);
    expect(json.error).toMatch(/no plan-billed path for vid-shared/);
  });

  test('reference validation failure exits 2 and never calls the provider', async () => {
    const atlas = new FakeProvider();
    const json = await run(req({ modelInput: 'vid-shared' }, { refs: [{ role: 'start', source: 'a' }, { role: 'identity', source: 'b' }] }), deps({ atlas }));
    expect(json.exit_code).toBe(2);
    expect(json.error).toMatch(/cannot combine start and identity/);
    expect(atlas.calls.generate).toHaveLength(0);
  });

  test('forced duration reaches the provider and is announced', async () => {
    const atlas = new FakeProvider();
    const json = await run(req({ modelInput: 'vid-shared' }, { duration: 5, refs: [{ role: 'identity', source: 'a' }] }), deps({ atlas }));
    expect(atlas.calls.generate[0].duration).toBe(8);
    expect(json.warnings.some((w) => w.includes('overridden to 8s'))).toBe(true);
  });

  test('--draft swaps to the draft model tier and suffixes the output', async () => {
    const google = new FakeProvider();
    await run(req({ modelInput: 'vid-shared', via: 'google', draft: true }, { output: '/tmp/clip.mp4' }), deps({ google }));
    expect(google.calls.generate[0]).toMatchObject({ model: 'vid-lite', output: '/tmp/clip.draft.mp4', draft: true });
  });

  test('--draft on a resolution tier keeps the model and lowers resolution', async () => {
    const atlas = new FakeProvider();
    await run(req({ modelInput: 'vid-shared', draft: true }, { resolution: '1080p' }), deps({ atlas }));
    expect(atlas.calls.generate[0]).toMatchObject({ model: 'vid-shared', resolution: '480p' });
  });

  test('--draft on a model without a tier is rejected', async () => {
    const json = await run(req({ draft: true }), deps({ google: new FakeProvider() }));
    expect(json.exit_code).toBe(2);
    expect(json.error).toMatch(/has no draft tier/);
  });

  test('--quote uses the provider quote and never generates', async () => {
    const atlas = new FakeProvider(undefined, 0.07).withQuote();
    const json = await run(req({ via: 'atlas', quoteOnly: true }), deps({ atlas }));
    expect(json).toMatchObject({ ok: true, exit_code: 0, quote_usd: 0.07 });
    expect(atlas.calls.generate).toHaveLength(0);
  });

  test('--quote falls back to list price; per-second prices scale by duration', async () => {
    const json = await run(req({ modelInput: 'vid-shared', via: 'google', quoteOnly: true }, { duration: 6 }), deps({ google: new FakeProvider() }));
    expect(json.quote_usd).toBeCloseTo(2.4);
  });

  test('--max-cost refuses above the limit and when no price exists', async () => {
    const atlas = new FakeProvider(undefined, 0.5).withQuote();
    const over = await run(req({ via: 'atlas', maxCost: 0.1 }), deps({ atlas }));
    expect(over.exit_code).toBe(2);
    expect(atlas.calls.generate).toHaveLength(0);
    const unpriced = await run(req({ modelInput: 'agy-image', maxCost: 1 }), deps({ agy: new FakeProvider() }));
    expect(unpriced.exit_code).toBe(2);
    expect(unpriced.error).toMatch(/no price is available/);
  });

  test('pending maps to 75, or 0 with --no-wait', async () => {
    const pending = new FakeProvider({ success: false, pending: true, jobId: 'j1' });
    expect((await run(req(), deps({ google: pending }))).exit_code).toBe(75);
    const json = await run(req({}, { noWait: true }), deps({ google: pending }));
    expect(json).toMatchObject({ ok: true, exit_code: 0, pending: true, job_id: 'j1' });
  });

  test('provider failure maps to 1', async () => {
    const json = await run(req(), deps({ google: new FakeProvider({ success: false, error: 'quota' }) }));
    expect(json).toMatchObject({ ok: false, exit_code: 1, error: 'quota' });
  });
});

describe('resumeJob', () => {
  const record = (status: JobRecord['status']): JobRecord => ({ id: 'r1', provider: 'atlas', model: 'img-shared', kind: 'image', output: '/tmp/o.png', submittedAt: '2026-10-04T00:00:00Z', status, outputs: status === 'completed' ? ['/tmp/o.jpg'] : undefined });

  test('resume of a completed job returns recorded outputs without any provider call', async () => {
    writeJob(record('completed'));
    const json = await resumeJob('r1', {}, deps({}));
    expect(json).toMatchObject({ ok: true, exit_code: 0, outputs: ['/tmp/o.jpg'] });
  });

  test('pending job resumes through the provider', async () => {
    writeJob(record('pending'));
    const atlas = new FakeProvider({ success: true, outputs: ['/tmp/o.png'] });
    const json = await resumeJob('r1', {}, deps({ atlas }));
    expect(atlas.calls.resume).toBe(1);
    expect(json.exit_code).toBe(0);
  });

  test('unknown id is a clear error', async () => {
    expect((await resumeJob('nope', {}, deps({}))).error).toMatch(/No job record for nope/);
  });
});

test('draftPath', () => {
  expect(draftPath('/a/b.mp4')).toBe('/a/b.draft.mp4');
  expect(draftPath('/a/b')).toBe('/a/b.draft');
});
```

`test/provenance.test.ts`:

```ts
import { expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { stampProvenance } from '../src/utils/provenance';
import type { ResultJson } from '../src/run';
import { tmpDir } from './helpers/registry';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.skipIf(!Bun.which('exiftool'))('stamps provider, model, and request into XMP', async () => {
  const file = path.join(tmpDir(), 'o.png');
  fs.writeFileSync(file, Buffer.from(PNG, 'base64'));
  const json = { provider: 'atlas', model: 'img-shared', provider_model_id: 'vendor/img/edit', billing: 'metered', request: { prompt_sent: 'cat', params: {}, refs: [], draft: false } } as unknown as ResultJson;
  await stampProvenance([file, path.join(tmpDir(), 'clip.mp4')], json);
  const tool = Bun.spawnSync(['exiftool', '-s3', '-XMP-xmp:CreatorTool', file]).stdout.toString().trim();
  expect(tool).toMatch(/^generate \S+ \(atlas\/img-shared\)$/);
  const desc = Bun.spawnSync(['exiftool', '-s3', '-XMP-dc:Description', file]).stdout.toString().trim();
  expect(JSON.parse(desc).request.prompt_sent).toBe('cat');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/run.test.ts test/provenance.test.ts`
Expected: FAIL with "Cannot find module '../src/run'".

- [ ] **Step 3: Implement `src/cost.ts`**

```ts
import type { GenerateOptions, ImageProvider, ModelSpec } from './types';

export interface PriceInfo {
  usd: number;
  source: 'quote' | 'list-price';
  unit?: string;
}

/** Provider quote when the provider can price a request; else the spec's list price. */
export async function priceFor(spec: ModelSpec, provider: ImageProvider, options: GenerateOptions): Promise<PriceInfo | undefined> {
  if (provider.quote) return { usd: await provider.quote({ ...options, model: spec.name }), source: 'quote' };
  const p = spec.direct_price;
  if (!p) return undefined;
  const usd = p.unit === 'second' ? p.usd * (options.duration ?? 8) : p.usd;
  return { usd, source: 'list-price', unit: p.unit };
}
```

- [ ] **Step 4: Implement `src/run.ts`**

```ts
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
```

- [ ] **Step 5: Implement `src/utils/provenance.ts`**

```ts
import pkg from '../../package.json';
import type { ResultJson } from '../run';

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** Embed provider, model, and the exact request into image XMP. No-op without exiftool. */
export async function stampProvenance(paths: string[], json: ResultJson): Promise<void> {
  const exiftool = Bun.which('exiftool');
  if (!exiftool) return;
  const description = JSON.stringify({
    provider: json.provider,
    model: json.model,
    provider_model_id: json.provider_model_id,
    billing: json.billing,
    request: json.request,
  });
  for (const file of paths.filter((p) => IMAGE_EXT.test(p))) {
    const proc = Bun.spawn(
      [exiftool, '-q', '-overwrite_original', `-XMP-xmp:CreatorTool=generate ${pkg.version} (${json.provider}/${json.model})`, `-XMP-dc:Description=${description}`, file],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`exiftool exited ${code} for ${file}: ${(await new Response(proc.stderr).text()).trim()}`);
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test test/run.test.ts test/provenance.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/cost.ts src/run.ts src/utils/provenance.ts test/run.test.ts test/provenance.test.ts
git commit -m "feat(run): orchestration with billing guarantees, draft tiers, price gate, provenance"
```

---

### Task 9: CLI wiring

**Files:**
- Modify: `src/cli.ts` (imports, `--jobs` early branch, new options, action body, help text)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `run`, `resumeJob`, `ResultJson`, `RunDeps` (Task 8); `getOrCreateProvider` (Task 1); `parseRefArg`, `attachNotes` (Task 2); `parseParams` (Task 2); `listJobs` (Task 3); `stampProvenance` (Task 8).
- Produces: the CLI surface in the spec's "New CLI surface" table.

- [ ] **Step 1: Write the failing tests**

`test/cli.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'path';
import { writeJob } from '../src/utils/jobs';
import { FIXTURE_FILES, FIXTURE_ROUTING } from './fixtures/registry';
import { tmpDir, useRealRegistry, writeRegistry } from './helpers/registry';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');
let env: Record<string, string>;

function cli(args: string[]) {
  const r = Bun.spawnSync(['bun', CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

beforeEach(() => {
  const root = writeRegistry(FIXTURE_FILES, FIXTURE_ROUTING);
  const jobs = tmpDir('gen-jobs-');
  process.env.GENERATE_JOBS_DIR = jobs;
  env = { ...(process.env as Record<string, string>), GENERATE_MODELS_DIR: path.join(root, 'models'), GENERATE_JOBS_DIR: jobs, ATLASCLOUD_API_KEY: 'test-key' };
});
afterAll(useRealRegistry);

describe('cli', () => {
  test('--jobs --json lists records', () => {
    writeJob({ id: 'j1', provider: 'atlas', model: 'img-shared', kind: 'image', output: '/tmp/o.png', submittedAt: '2026-10-04T00:00:00Z', status: 'pending' });
    const r = cli(['--jobs', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)[0].id).toBe('j1');
  });

  test('invalid reference combination exits 2 with a JSON error and sends nothing', () => {
    const r = cli(['-m', 'vid-shared', 'walk', '--ref', 'start=a.png', '--ref', 'identity=b.png', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/cannot combine start and identity/);
  });

  test('--billing plan on a video model exits 2', () => {
    const r = cli(['-m', 'vid-shared', 'walk', '--billing', 'plan', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/no plan-billed path/);
  });

  test('bad --ref syntax exits 2', () => {
    const r = cli(['-m', 'img-shared', 'x', '--ref', 'face=a.png', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/Unknown reference role/);
  });

  test('--resume of an unknown id exits 1', () => {
    const r = cli(['--resume', 'nope', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatch(/No job record for nope/);
  });

  test('--resume of a completed job prints its outputs', () => {
    writeJob({ id: 'done1', provider: 'atlas', model: 'img-shared', kind: 'image', output: '/tmp/o.png', submittedAt: '2026-10-04T00:00:00Z', status: 'completed', outputs: ['/tmp/o.jpg'] });
    const r = cli(['--resume', 'done1', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).outputs).toEqual(['/tmp/o.jpg']);
  });

  test('--json keeps stdout to exactly one JSON document', () => {
    const r = cli(['-m', 'vid-shared', 'walk', '--billing', 'plan', '--json']);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/cli.test.ts`
Expected: FAIL (unknown options `--jobs`, `--json`, `--ref`, `--billing`, `--resume`).

- [ ] **Step 3: Update imports at the top of `src/cli.ts`**

Replace lines 5-10 with:

```ts
import { spawn } from 'child_process';
import type { Ora } from 'ora';
import { getOrCreateProvider, listModels } from './providers';
import { removeBackground, addBackgroundColor } from './utils/background';
import { generateThumbnail } from './utils/thumbnail';
import type { AspectRatio, Provider, RoleRef } from './types';
import { DEFAULT_OPTIONS } from './types';
import { getModelSpec, listModelSpecs, loadModelRegistry, modelsConfigDir, resolveModel } from './config/models';
import { attachNotes, parseRefArg } from './refs';
import { parseParams } from './params';
import { listJobs } from './utils/jobs';
import { stampProvenance } from './utils/provenance';
import { resumeJob, run, type ResultJson, type RunDeps } from './run';
```

- [ ] **Step 4: Add the `--jobs` early branch**

Directly after the `--list-models` block (after its `process.exit(0);` and closing brace), add:

```ts
if (process.argv.includes('--jobs')) {
  const jobs = listJobs();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(jobs) + '\n');
  } else if (jobs.length === 0) {
    console.log('No recorded jobs.');
  } else {
    for (const j of jobs) {
      const status = j.status === 'pending' ? chalk.yellow(j.status) : j.status === 'failed' ? chalk.red(j.status) : chalk.green(j.status);
      console.log(`${status}  ${j.submittedAt}  ${j.provider}/${j.model}  ${j.id}`);
      if (j.outputs?.length) console.log(chalk.dim(`    ${j.outputs.join(', ')}`));
      if (j.error) console.log(chalk.dim(`    ${j.error.message}`));
    }
  }
  process.exit(0);
}

const collect = (value: string, previous: string[]) => [...previous, value];
```

- [ ] **Step 5: Add the new options**

After `.option('--list-models', 'List available models and exit')` add:

```ts
  .option('--via <provider>', 'Use this provider for the model (see "also via" in --list-models)')
  .addOption(new Option('--billing <kind>', 'plan = subscription limits only; metered = per-call only').choices(['plan', 'metered', 'any']).default('any'))
  .option('--quote', 'Print the price of this request and exit without generating')
  .option('--max-cost <usd>', 'Refuse to submit if the price exceeds this many US dollars', parseFloat)
  .option('--wait <seconds>', 'Seconds to wait for an async job before printing a resume command', parseInt)
  .option('--no-wait', 'Submit, record the job, print its id, and exit')
  .option('--resume <id>', 'Finish a recorded job and download its outputs')
  .option('--jobs', 'List recorded jobs and exit')
  .option('--param <key=value>', 'Model-specific request field; repeatable', collect, [])
  .option('--ref <role=path>', 'Role-typed reference (start|end|identity|style|object|location); repeatable', collect, [])
  .option('--ref-note <n=text>', 'What the n-th --ref is for; repeatable', collect, [])
  .option('--draft', "Run on the model's cheaper draft tier; output gets a .draft suffix")
  .option('--json', 'Print one JSON result to stdout; progress goes to stderr')
```

Commander note: with both `--wait <seconds>` and `--no-wait` defined, `opts.wait` is `undefined` by default, a number when `--wait N` is given, and `false` when `--no-wait` is given.

- [ ] **Step 6: Replace the action body**

Replace the whole `.action(async (promptArgs: string[], opts) => { ... });` (lines 152-312 in the original) with:

```ts
  .action(async (promptArgs: string[], opts) => {
    const jsonMode = Boolean(opts.json);
    const waitSeconds = typeof opts.wait === 'number' ? opts.wait : undefined;
    const noWait = opts.wait === false;
    const deps: RunDeps = { getProvider: getOrCreateProvider, stamp: stampProvenance };
    const spinner = ora({ text: 'Working...', spinner: 'dots', isSilent: jsonMode }).start();
    const onProgress = (status: string) => {
      spinner.text = status;
    };

    if (opts.resume) {
      emitResult(await resumeJob(opts.resume, { waitSeconds, onProgress }, deps), jsonMode, spinner);
    }

    const cliPrompt = promptArgs.length > 0 ? promptArgs.join(' ') : (opts.prompt || '');
    const stdinPrompt = await readStdinIfAvailable(Boolean(cliPrompt));
    let prompt: string;
    if (stdinPrompt && cliPrompt) {
      prompt = `<prompt>\n${stdinPrompt}\n</prompt>\n\n<additional_guidance>\n${cliPrompt}\n</additional_guidance>`;
    } else {
      prompt = stdinPrompt || cliPrompt;
    }
    if (!prompt) {
      emitResult(rejected(1, 'Prompt is required. Usage: generate "your prompt" or via stdin.'), jsonMode, spinner);
    }

    let refs: RoleRef[] = [];
    let params: Record<string, unknown> = {};
    try {
      refs = attachNotes((opts.ref as string[]).map(parseRefArg), opts.refNote as string[]);
      params = parseParams(opts.param as string[]);
    } catch (err) {
      emitResult(rejected(2, err instanceof Error ? err.message : String(err)), jsonMode, spinner);
    }

    let kind: 'image' | 'video' | 'audio' = 'image';
    try {
      const resolved = resolveModel(opts.model);
      kind = getModelSpec(resolved).kind;
      const deprecation = getModelSpec(resolved).deprecated;
      if (deprecation && !jsonMode) console.error(chalk.yellow(`Warning: ${resolved} is deprecated. ${deprecation}`));
    } catch (err) {
      emitResult(rejected(1, err instanceof Error ? err.message : String(err)), jsonMode, spinner);
    }

    const defaultOut = kind === 'video' ? DEFAULT_OPTIONS.videoOutput : kind === 'audio' ? DEFAULT_OPTIONS.audioOutput : DEFAULT_OPTIONS.output;
    let outputPath: string = opts.output || defaultOut;
    if (kind === 'video' && /\.(png|jpg|jpeg|webp)$/i.test(outputPath)) outputPath = outputPath.replace(/\.(png|jpg|jpeg|webp)$/i, '.mp4');
    if (kind === 'audio' && /\.(png|jpg|jpeg|webp|mp4)$/i.test(outputPath)) outputPath = outputPath.replace(/\.(png|jpg|jpeg|webp|mp4)$/i, '.mp3');

    const variationCount = kind === 'image' && !opts.quote ? opts.variations || 1 : 1;
    const ext = outputPath.match(/\.[A-Za-z0-9]+$/)?.[0] || '';
    const basePath = ext ? outputPath.slice(0, -ext.length) : outputPath;

    const merged: string[] = [];
    let last: ResultJson | undefined;
    for (let i = 1; i <= variationCount; i++) {
      const itemOutput = variationCount > 1 ? `${basePath}-v${i}${ext}` : outputPath;
      if (variationCount > 1) onProgress(`Generating variation ${i}/${variationCount}...`);
      last = await run(
        {
          modelInput: opts.model,
          via: opts.via as Provider | undefined,
          billing: opts.billing,
          draft: Boolean(opts.draft),
          quoteOnly: Boolean(opts.quote),
          maxCost: opts.maxCost,
          options: {
            prompt,
            size: opts.size,
            resolution: opts.resolution,
            duration: opts.duration,
            fps: opts.fps,
            aspectRatio: opts.aspectRatio as AspectRatio,
            output: itemOutput,
            referenceImages: opts.reference,
            refs,
            params,
            transparent: opts.transparent,
            removeBg: opts.removeBg,
            addBg: opts.addBg,
            negativePrompt: opts.negativePrompt,
            thumbnail: opts.thumbnail,
            seed: opts.seed,
            steps: opts.steps,
            guidance: opts.guidance,
            quality: opts.quality,
            style: opts.style,
            numImages: opts.numImages,
            useApi: opts.api,
            waitSeconds,
            noWait,
            onProgress,
          },
        },
        deps
      );
      if (!last.ok || last.pending || opts.quote) emitResult(last, jsonMode, spinner);

      for (const file of last.outputs) {
        if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
        if (opts.removeBg) {
          onProgress('Removing background...');
          await removeBackground(file, file);
        }
        if (opts.addBg) {
          onProgress('Adding background color...');
          await addBackgroundColor(file, file, opts.addBg);
        }
        if (opts.thumbnail) {
          onProgress('Generating thumbnail...');
          await generateThumbnail(file, { size: typeof opts.thumbnail === 'number' ? opts.thumbnail : 256 });
        }
      }
      merged.push(...last.outputs);
    }
    emitResult({ ...last!, outputs: merged }, jsonMode, spinner);
  });

function rejected(code: 1 | 2, error: string): ResultJson {
  return { ok: false, provider: null, model: null, provider_model_id: null, outputs: [], job_id: null, quote_usd: null, billing: null, agentic: false, request: null, error, exit_code: code, warnings: [] };
}

function emitResult(json: ResultJson, jsonMode: boolean, spinner: Ora): never {
  if (jsonMode) {
    spinner.stop();
    process.stdout.write(JSON.stringify(json) + '\n');
    process.exit(json.exit_code);
  }
  for (const w of json.warnings) console.error(chalk.yellow(`Warning: ${w}`));
  if (json.exit_code === 75) {
    spinner.warn(chalk.yellow(json.error ?? 'Still running'));
    process.exit(75);
  }
  if (!json.ok) {
    spinner.fail(chalk.red(json.error ?? 'Failed'));
    process.exit(json.exit_code);
  }
  if (json.pending) {
    spinner.info(`Submitted job ${json.job_id}. Resume with: generate --resume ${json.job_id}`);
    process.exit(0);
  }
  if (json.quote_usd !== null && json.outputs.length === 0) {
    spinner.succeed(`Price: $${json.quote_usd.toFixed(4)}  (${json.model} via ${json.provider}, ${json.billing})`);
    process.exit(0);
  }
  spinner.succeed(chalk.green('Done'));
  console.log();
  console.log(chalk.dim('─'.repeat(50)));
  if (json.outputs.length > 1) {
    console.log(chalk.bold('  Outputs:'));
    for (const p of json.outputs) console.log(`    ${chalk.cyan(p)}`);
  } else {
    console.log(chalk.bold('  Output:'), chalk.cyan(json.outputs[0] ?? '(none)'));
  }
  console.log(chalk.bold('  Model:'), `${json.model} via ${json.provider} (${json.billing})`);
  if (json.job_id) console.log(chalk.bold('  Job:'), json.job_id);
  console.log(chalk.dim('─'.repeat(50)));
  console.log();
  if (process.platform === 'darwin' && json.outputs[0]) {
    spawn('open', [json.outputs[0]], { detached: true, stdio: 'ignore' }).unref();
  }
  process.exit(0);
}
```

The divider character `─` is the existing box-drawing line from the original output, not a dash in prose.

- [ ] **Step 7: Extend the help text**

In the `addHelpText('after', ...)` template, add before `${chalk.bold('Stdin Support:')}`:

```ts
  ${chalk.dim('# Price a request without generating; refuse anything over 50 cents')}
  $ generate -m kling-3-pro "a dancer spins" --ref start=./pose.png --quote
  $ generate -m kling-3-pro "a dancer spins" --ref start=./pose.png --max-cost 0.50

  ${chalk.dim('# Unpaid (plan-billed) path only; fails rather than spending money')}
  $ generate -m gpt-image-2 "a lighthouse at dusk" --billing plan

  ${chalk.dim('# Cheap draft first, then the final on the same settings')}
  $ generate -m veo-3.1 "waves at night" --draft
  $ generate -m veo-3.1 "waves at night"

  ${chalk.dim('# Long jobs: return immediately, finish later')}
  $ generate -m seedance-2 "city timelapse" --no-wait
  $ generate --jobs
  $ generate --resume <id>

${chalk.bold('Exit codes:')}
  0 done   1 failed   2 rejected before anything was sent   75 still running (use --resume)
```

and add `ATLASCLOUD_API_KEY                Required for Atlas models` to the Environment Variables list.

- [ ] **Step 8: Run all tests and typecheck**

Run: `bun test && bunx tsc --noEmit && bun src/cli.ts --help | grep -E -- '--(via|billing|quote|resume|ref)'`
Expected: all tests PASS; tsc exit 0; the five flags appear in help.

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): --via, --billing, --quote, --max-cost, --ref, --draft, --jobs, --resume, --json"
```

---

### Task 10: Real catalogs, contract probe, and the price table

**Files:**
- Create: `config/models/atlas.yaml`, `config/models/codex.yaml`, `config/models/agy.yaml`, `scripts/verify-atlas-models.ts`, `scripts/quote-table.ts`, `test/fixtures/atlas/calculate.json`, `test/fixtures/atlas/upload.json`
- Modify: `config/routing.yaml`; `config/models/google.yaml`, `openai.yaml`, `replicate.yaml` (`direct_price` on shared names); `src/providers/atlas-client.ts` (`QUOTE_PATHS` order); `test/atlas-client.test.ts`
- Test: `test/quote-table.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `formatQuoteTable(rows: QuoteRow[]): string` and `interface QuoteRow { model: string; provider: Provider; billing: Billing; usd: number | null; basis: string; routed: boolean; source?: string }`.

- [ ] **Step 1: Contract probe (free; needs the Atlas key)**

Run:

```bash
mkdir -p test/fixtures/atlas
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -D > /tmp/probe.png
KEY="${ATLASCLOUD_API_KEY:-$(security find-generic-password -s ATLASCLOUD_API_KEY -w)}"
curl -s -X POST https://api.atlascloud.ai/api/v1/model/uploadMedia -H "Authorization: Bearer $KEY" -F "file=@/tmp/probe.png" | tee test/fixtures/atlas/upload.json; echo
curl -s -X POST https://api.atlascloud.ai/api/v1/model/calculate -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"google/nano-banana-2/text-to-image","prompt":"probe"}' | tee test/fixtures/atlas/calculate.json; echo
```

Expected: two JSON documents. Replace any temporary URL in `upload.json` with `https://example.invalid/probe.png` before committing (it is a public repo). Then:
- If the price in `calculate.json` sits at a path already in `QUOTE_PATHS`, move that path to the front of the array.
- If it sits elsewhere (for example `data.amount_usd`), add that path to the front.
- If the upload URL is not at `url`, `data.url`, or `data.download_url`, add its path to `upload()`.

Add a fixture-driven test to `test/atlas-client.test.ts`:

```ts
import calculateFixture from './fixtures/atlas/calculate.json';
import uploadFixture from './fixtures/atlas/upload.json';

test('parses the live /calculate shape', () => {
  expect(parseQuote(calculateFixture)).toBeGreaterThan(0);
});

test('reads the live upload shape', async () => {
  const file = path.join(tmpDir(), 'a.png');
  fs.writeFileSync(file, 'png');
  const { impl } = fakeFetch([json(uploadFixture)]);
  expect(await new AtlasClient('k', impl).upload(file)).toBe('https://example.invalid/probe.png');
});
```

Run: `bun test test/atlas-client.test.ts`
Expected: PASS.

- [ ] **Step 2: Write `config/models/atlas.yaml`**

For each entry, open the model's reference page in the Atlas model library, confirm the id variants and field names, and record the page URL and check date in a comment directly above the entry. Remove any entry or field you cannot confirm. Start from:

```yaml
# Atlas Cloud models (reseller; https://api.atlascloud.ai/api/v1).
# Every id and input field below was confirmed on the model's reference page
# (URL + date in the comment above each entry) and by
# `bun scripts/verify-atlas-models.ts`. Never copy ids from guide-page examples.
#
#   id / edit_id / i2v_id / r2v_id   task variants; chosen from the references given
#   billing      always metered here
#   refs         role caps, exclusive groups, forced durations (see src/refs.ts)
#   label_style  prose | at-index | wan-numbered
#   draft        cheaper preview tier: { model } or { resolution }
#   inputs       request field names for CLI options (image, images, max_images,
#                end_image, duration, resolution, resolution_values,
#                aspect_ratio, seed, negative_prompt, prompt)

provider: atlas

models:
  # --- image, shared with direct providers ---
  nano-banana-2:
    id: google/nano-banana-2/text-to-image
    edit_id: google/nano-banana-2/edit
    kind: image
    billing: metered
    description: Gemini 3.1 Flash Image via Atlas.
    label_style: prose
    refs: { identity: 6, style: 4, object: 6, location: 4 }
    inputs: { images: images, max_images: 14, aspect_ratio: aspect_ratio, resolution: resolution, resolution_values: { 1K: 1k, 2K: 2k, 4K: 4k }, seed: seed }

  nano-banana-pro:
    id: google/nano-banana-pro/text-to-image
    edit_id: google/nano-banana-pro/edit
    kind: image
    billing: metered
    description: Gemini 3 Pro Image via Atlas.
    label_style: prose
    refs: { identity: 6, style: 4, object: 6, location: 4 }
    inputs: { images: images, max_images: 14, aspect_ratio: aspect_ratio, resolution: resolution, resolution_values: { 1K: 1k, 2K: 2k, 4K: 4k }, seed: seed }

  gpt-image-2:
    id: openai/gpt-image-2/text-to-image
    edit_id: openai/gpt-image-2/edit
    kind: image
    billing: metered
    description: GPT Image 2 via Atlas.
    label_style: prose
    refs: { identity: 4, style: 2, object: 4, location: 2 }
    inputs: { images: images, aspect_ratio: aspect_ratio }

  flux-2-pro:
    id: black-forest-labs/flux-2-pro/text-to-image
    edit_id: black-forest-labs/flux-2-pro/edit
    kind: image
    billing: metered
    description: FLUX.2 Pro via Atlas.
    label_style: prose
    refs: { identity: 4, style: 2, object: 4, location: 2 }
    inputs: { images: images, max_images: 8, aspect_ratio: aspect_ratio, seed: seed }

  # --- image, Atlas only ---
  seedream-5-pro:
    id: bytedance/seedream-v5.0-pro/text-to-image
    kind: image
    billing: metered
    description: ByteDance Seedream 5.0 Pro.
    inputs: { aspect_ratio: aspect_ratio, seed: seed }

  seedream-4.5:
    id: bytedance/seedream-v4.5
    edit_id: bytedance/seedream-v4.5/edit
    kind: image
    billing: metered
    description: ByteDance Seedream 4.5, with editing.
    label_style: prose
    refs: { identity: 4, style: 2, object: 4, location: 2 }
    inputs: { images: images, aspect_ratio: aspect_ratio, seed: seed }

  ideogram-4:
    id: ideogram/v4/quality/text-to-image
    kind: image
    billing: metered
    description: Ideogram 4 (quality). Strong typography.
    inputs: { aspect_ratio: aspect_ratio, seed: seed, negative_prompt: negative_prompt }

  # --- video ---
  veo-3.1:
    id: google/veo3.1/text-to-video
    i2v_id: google/veo3.1/image-to-video
    r2v_id: google/veo3.1/reference-to-video
    kind: video
    billing: metered
    description: Veo 3.1 via Atlas. Identity refs force 8 s; first+last frame only at 8 s.
    label_style: prose
    refs: { start: 1, end: 1, identity: 3, exclusive: [[start, identity], [end, identity]], forces: { identity: { duration: 8 }, end: { duration: 8 } } }
    draft: { model: veo-3.1-fast }
    inputs: { image: image, end_image: last_image, images: images, duration: duration, resolution: resolution, aspect_ratio: aspect_ratio, seed: seed, negative_prompt: negative_prompt }

  veo-3.1-fast:
    id: google/veo3.1-fast/text-to-video
    i2v_id: google/veo3.1-fast/image-to-video
    kind: video
    billing: metered
    description: Veo 3.1 Fast via Atlas.
    label_style: prose
    refs: { start: 1, end: 1 }
    inputs: { image: image, end_image: last_image, duration: duration, resolution: resolution, aspect_ratio: aspect_ratio, seed: seed, negative_prompt: negative_prompt }

  kling-3-pro:
    id: kwaivgi/kling-v3.0-pro/text-to-video
    i2v_id: kwaivgi/kling-v3.0-pro/image-to-video
    kind: video
    billing: metered
    description: Kling 3.0 Pro. Cinematic motion; add --param sound=true for native audio.
    refs: { start: 1, end: 1 }
    inputs: { image: image, end_image: end_image, duration: duration, aspect_ratio: aspect_ratio, negative_prompt: negative_prompt }

  seedance-2:
    id: bytedance/seedance-2.0/text-to-video
    i2v_id: bytedance/seedance-2.0/image-to-video
    kind: video
    billing: metered
    description: Seedance 2.0. Token-billed; quotes are estimates. Draft at 480p.
    refs: { start: 1, end: 1 }
    draft: { resolution: 480p }
    inputs: { image: image, end_image: end_image, duration: duration, resolution: resolution, aspect_ratio: aspect_ratio, seed: seed }

  wan-2.7:
    id: alibaba/wan-2.7/text-to-video
    i2v_id: alibaba/wan-2.7/image-to-video
    kind: video
    billing: metered
    description: Wan 2.7. 5/10/15 s.
    label_style: wan-numbered
    refs: { start: 1, end: 1 }
    inputs: { image: image, end_image: end_image, duration: duration, resolution: resolution, seed: seed, negative_prompt: negative_prompt }

  # --- audio ---
  minimax-music-3:
    id: minimax/music-3.0
    kind: audio
    billing: metered
    description: MiniMax Music 3.0. Prompt describes the music; lyrics via --param lyrics=...

  suno-v5:
    id: suno/chirp-v5
    kind: audio
    billing: metered
    description: Suno chirp v5 songs.

  elevenlabs-v3-tts:
    id: elevenlabs/v3/text-to-speech
    kind: audio
    billing: metered
    description: ElevenLabs v3 text to speech. Voice via --param voice=...
    inputs: { prompt: text }
```

Not included until confirmed on a reference page: Gemini Omni Flash, Seedance 2.5 (API was "coming soon" at launch), Kling Omni (O3), MiniMax H3, Vidu Q3. Add each with its own confirmed entry when its page exists.

- [ ] **Step 3: Write `config/models/codex.yaml` and `config/models/agy.yaml`**

`config/models/codex.yaml`:

```yaml
# Codex CLI image generation through its built-in $imagegen skill.
# Billed against the Codex plan's usage limits (shared with every other use of
# the same account), not per call. Agentic: inspects and may revise its output.
#   agent_model       optional --model for `codex exec`; omit to use Codex's configured default
#   reasoning_effort  model_reasoning_effort passed to codex exec
#   timeout_seconds   process timeout (default 600)

provider: codex

models:
  gpt-image-2:
    id: gpt-image-2
    kind: image
    billing: plan
    agentic: true
    reasoning_effort: high
    timeout_seconds: 600
    description: GPT Image 2 via Codex $imagegen. Unpaid at the margin; slower; good for conservative restoration.
    direct_price: { usd: 0, unit: plan limits }
```

`config/models/agy.yaml`:

```yaml
# Antigravity CLI image generation, billed against the Google plan the CLI is
# signed in with. The CLI does not report which image model it used; a
# 2026-10-04 run produced 1376x768 for 16:9, consistent with a Gemini 3-family
# image model (inferred, not reported).

provider: agy

models:
  agy-image:
    id: agy default agent model
    kind: image
    billing: plan
    agentic: true
    reasoning_effort: high
    timeout_seconds: 600
    description: Antigravity image generation. Unpaid at the margin; generates well, weaker at restoration, slower.
    direct_price: { usd: 0, unit: plan limits }
```

- [ ] **Step 4: Record direct list prices on shared names and set routing**

Look up current list prices on the official pages (Gemini API pricing for `nano-banana-2`, `nano-banana-pro`, `veo-3.1`, `veo-3.1-fast`; OpenAI API pricing for `gpt-image-2` at 1024x1024 medium quality; the Replicate model page for `flux-2-pro` at 1 MP). Add to each of those six entries in its direct provider's YAML, with real values:

```yaml
    direct_price: { usd: <price>, unit: <image|second>, source: <official pricing URL>, checked: 2026-10-<dd> }
```

Then set `config/routing.yaml` entries below its header comment (every shared name stays on its direct provider until the quote table and a parity check justify a change):

```yaml
nano-banana-2: google
nano-banana-pro: google
gpt-image-2: openai
flux-2-pro: replicate
veo-3.1: google
veo-3.1-fast: google
```

- [ ] **Step 5: Write `scripts/verify-atlas-models.ts`**

```ts
#!/usr/bin/env bun
/**
 * Ask Atlas's free /model/calculate endpoint to price a minimal request for
 * every model id declared in config/models/atlas.yaml (base, edit, i2v, r2v).
 * /calculate creates no task and charges nothing. An unknown id fails here
 * instead of failing (or misbehaving) on a paid request.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadModelRegistry } from '../src/config/models';
import { AtlasClient } from '../src/providers/atlas-client';
import { resolveApiKey } from '../src/utils/keychain';
import type { ModelSpec } from '../src/types';

const key = resolveApiKey(['ATLASCLOUD_API_KEY']);
if (!key) {
  console.error('ATLASCLOUD_API_KEY is required');
  process.exit(1);
}
const client = new AtlasClient(key);

const png = path.join(os.tmpdir(), 'verify-atlas.png');
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const imageUrl = await client.upload(png);

const atlasSpecs = Object.values(loadModelRegistry().offers)
  .map((o) => o.atlas)
  .filter((s): s is ModelSpec => Boolean(s));

let failures = 0;
for (const spec of atlasSpecs) {
  const inputs = spec.inputs ?? {};
  const promptField = inputs.prompt ?? 'prompt';
  const variants: Array<[string, string | undefined, Record<string, unknown>]> = [
    ['base', spec.id, {}],
    ['edit', spec.edit_id, inputs.images ? { [inputs.images]: [imageUrl] } : inputs.image ? { [inputs.image]: imageUrl } : {}],
    ['i2v', spec.i2v_id, inputs.image ? { [inputs.image]: imageUrl } : {}],
    ['r2v', spec.r2v_id, inputs.images ? { [inputs.images]: [imageUrl] } : {}],
  ];
  for (const [label, id, extra] of variants) {
    if (!id) continue;
    try {
      const usd = await client.calculate({ model: id, [promptField]: 'verification', ...extra });
      console.log(`ok    ${spec.name.padEnd(20)} ${label.padEnd(5)} ${id}  $${usd}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${spec.name.padEnd(20)} ${label.padEnd(5)} ${id}  ${(err as Error).message}`);
    }
  }
}
process.exit(failures ? 1 : 0);
```

Run: `bun scripts/verify-atlas-models.ts`
Expected: one line per declared id. For each `FAIL`, correct the id from its reference page or remove the variant/entry, then rerun until the exit code is 0.

- [ ] **Step 6: Write the failing quote-table test**

`test/quote-table.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { formatQuoteTable } from '../scripts/quote-table';

test('formats rows with deltas against the routed provider', () => {
  const md = formatQuoteTable([
    { model: 'nano-banana-2', provider: 'google', billing: 'metered', usd: 0.04, basis: 'list price per image', routed: true, source: 'https://ai.google.dev/pricing (2026-10-05)' },
    { model: 'nano-banana-2', provider: 'atlas', billing: 'metered', usd: 0.03, basis: '/calculate 1K 16:9', routed: false },
    { model: 'gpt-image-2', provider: 'codex', billing: 'plan', usd: 0, basis: 'plan limits', routed: false },
    { model: 'gpt-image-2', provider: 'openai', billing: 'metered', usd: null, basis: 'no price recorded', routed: true },
  ]);
  expect(md).toContain('| Model | Provider | Billing | USD | Basis | vs routed | Source |');
  expect(md).toContain('| nano-banana-2 | atlas | metered | 0.0300 | /calculate 1K 16:9 | -25% |  |');
  expect(md).toContain('| nano-banana-2 | google (routed) | metered | 0.0400 |');
  expect(md).toContain('| gpt-image-2 | codex | plan | 0 marginal (plan limits) | plan limits | n/a |  |');
});
```

Run: `bun test test/quote-table.test.ts`
Expected: FAIL with "Cannot find module '../scripts/quote-table'".

- [ ] **Step 7: Implement `scripts/quote-table.ts`**

```ts
#!/usr/bin/env bun
/**
 * Price every model name offered by more than one provider, at standard
 * settings, and print a markdown table. Atlas rows come from /calculate (free);
 * direct rows come from direct_price in YAML; plan rows show $0 marginal.
 * This script never edits config/routing.yaml.
 */
import { loadModelRegistry } from '../src/config/models';
import { getOrCreateProvider } from '../src/providers';
import { priceFor } from '../src/cost';
import type { Billing, GenerateOptions, ModelSpec, Provider } from '../src/types';

export interface QuoteRow {
  model: string;
  provider: Provider;
  billing: Billing;
  usd: number | null;
  basis: string;
  routed: boolean;
  source?: string;
}

export function formatQuoteTable(rows: QuoteRow[]): string {
  const routedPrice = new Map(rows.filter((r) => r.routed).map((r) => [r.model, r.usd]));
  const lines = ['| Model | Provider | Billing | USD | Basis | vs routed | Source |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const base = routedPrice.get(r.model);
    const usd = r.billing === 'plan' ? '0 marginal (plan limits)' : r.usd === null ? 'n/a' : r.usd.toFixed(4);
    let delta = 'n/a';
    if (!r.routed && r.billing === 'metered' && r.usd !== null && base) delta = `${Math.round(((r.usd - base) / base) * 100)}%`;
    if (r.routed) delta = 'routed';
    lines.push(`| ${r.model} | ${r.provider}${r.routed ? ' (routed)' : ''} | ${r.billing} | ${usd} | ${r.basis} | ${delta} | ${r.source ?? ''} |`);
  }
  return lines.join('\n');
}

function standardOptions(spec: ModelSpec): GenerateOptions {
  if (spec.kind === 'video') return { model: spec.name, prompt: 'price check', duration: 8, resolution: '720p', aspectRatio: '16:9' };
  if (spec.kind === 'audio') return { model: spec.name, prompt: 'price check, thirty seconds', params: { duration: 30 } };
  return { model: spec.name, prompt: 'price check', size: '1K', aspectRatio: '16:9' };
}

if (import.meta.main) {
  const reg = loadModelRegistry();
  const rows: QuoteRow[] = [];
  for (const [name, offers] of Object.entries(reg.offers)) {
    const specs = Object.values(offers) as ModelSpec[];
    if (specs.length < 2) continue;
    for (const spec of specs) {
      const routed = reg.models[name].provider === spec.provider;
      try {
        const price = await priceFor(spec, getOrCreateProvider(spec.provider), standardOptions(spec));
        rows.push({
          model: name,
          provider: spec.provider,
          billing: spec.billing,
          usd: price?.usd ?? null,
          basis: price ? (price.source === 'quote' ? `/calculate ${spec.kind === 'video' ? '8s 720p' : spec.kind === 'audio' ? '30s' : '1K 16:9'}` : `list price per ${price.unit}`) : 'no price recorded',
          routed,
          source: spec.direct_price?.source ? `${spec.direct_price.source} (${spec.direct_price.checked ?? 'undated'})` : undefined,
        });
      } catch (err) {
        rows.push({ model: name, provider: spec.provider, billing: spec.billing, usd: null, basis: `error: ${(err as Error).message.slice(0, 80)}`, routed });
      }
    }
  }
  console.log(formatQuoteTable(rows));
}
```

Run: `bun test test/quote-table.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 8: Produce the table**

Run: `bun scripts/quote-table.ts | tee docs/quote-table-$(date +%Y-%m).md`
Expected: one row per offer of each shared name. Do not edit `routing.yaml` in this task; routing changes are the owner's decision under the spec's flip rule (at least 10% cheaper plus a same-prompt parity check).

- [ ] **Step 9: Run everything and commit**

Run: `bun test && bunx tsc --noEmit && bun src/cli.ts --list-models | grep -E 'also via|\(plan\)'`
Expected: PASS; tsc 0; shared names show "also via" lines and plan models show "(plan)".

```bash
git add config scripts test src/providers/atlas-client.ts docs/quote-table-*.md
git commit -m "feat(catalog): Atlas, Codex, and Antigravity models; verified ids; price table"
```

---

### Task 11: Docs, version, build, and live smoke

**Files:**
- Modify: `README.md`, `package.json`
- No new tests (live behaviour is checked by hand below)

- [ ] **Step 1: README**

Add a section after `## Usage`:

```markdown
## Providers, billing, and routing

One model name can be offered by several providers. `config/routing.yaml` says
which one serves it; `--via <provider>` picks another for one call.

| Provider | Billing | Notes |
|---|---|---|
| google, openai, replicate | metered | Direct APIs |
| atlas | metered | Reseller for 300+ image, video, and audio models; prices quoted with `--quote` |
| codex | plan | Codex `$imagegen`; draws on Codex plan limits; agentic and slower |
| agy | plan | Antigravity CLI; draws on the signed-in Google plan; agentic and slower |

`--billing plan` never reaches a metered path, and `--billing metered` never
reaches a plan path; if no matching path exists the command fails and names
the alternatives. Video is always metered.

## Long jobs

Async jobs are recorded under `~/.cache/generate/jobs/` before the first poll.
If a job outlives `--wait` (defaults: image 120 s, video 600 s, audio 300 s),
`generate` exits 75 and prints `generate --resume <id>`. A submit is never
retried automatically, because a second submit is a second paid job.

## References

`--ref <role>=<path|url>` with roles `start`, `end`, `identity`, `style`,
`object`, `location`; `--ref-note <n>=<text>` says what the n-th one is for.
Each model's reference rules (counts, combinations that are not allowed,
durations they force) are checked before anything is sent.

## Exit codes

`0` done, `1` failed, `2` rejected before anything was sent, `75` still running.
```

and add `ATLASCLOUD_API_KEY` to the `## Authentication & Keychain` section with its Keychain service name `ATLASCLOUD_API_KEY`.

- [ ] **Step 2: Version and build**

Run:

```bash
sed -i '' 's/"version": "1.3.0"/"version": "1.4.0"/' package.json
bun test && bunx tsc --noEmit && bun run build && generate --version
```

Expected: tests PASS; tsc 0; `generate --version` prints `1.4.0`.

- [ ] **Step 3: Commit**

```bash
git add README.md package.json
git commit -m "docs: providers, billing, long jobs, references; release 1.4.0"
```

- [ ] **Step 4: Live smoke (STOP: owner go-ahead required, about USD 1)**

Ask the owner before running. Then, in a scratch directory:

```bash
generate -m nano-banana-2 --via atlas "a lighthouse at dusk" --quote
generate -m nano-banana-2 --via atlas "a lighthouse at dusk" -o atlas-img.png --json
generate -m nano-banana-2 --via atlas "make it night" -r atlas-img.* -o atlas-edit.png --json
generate -m veo-3.1-lite "rain on a window" --duration 4 --wait 5 --json; echo "exit=$?"
generate --jobs
generate --resume <id printed above> --json
generate -m kling-3-pro --ref start=atlas-img.* "slow push-in, waves move" --max-cost 0.60 --json
generate -m elevenlabs-v3-tts "Testing one two three." -o tts.mp3 --json
generate -m gpt-image-2 --billing plan "a lighthouse at dusk" -o codex.png --json
generate -m agy-image "a lighthouse at dusk" -o agy.png --json
```

Check, recording each result in the spec's evidence notes:
- every JSON has `ok: true` (the Veo line first exits 75 and its resume returns `ok: true`);
- `exiftool -s3 -XMP-xmp:CreatorTool atlas-img.*` names `atlas/nano-banana-2`;
- the Atlas dashboard shows exactly one task per submitted command (no duplicates);
- `codex.png` and `agy.png` are valid PNGs, and their runs made no metered calls;
- re-time the agy run and note it next to the 179 s spike figure.

If any line fails, stop and report the failing command with its JSON output rather than retrying.
