# Add Atlas Cloud as a Provider, with Resumable Async Jobs and Cost-Based Routing

**Status:** Draft (design approved in conversation 2026-10-04; awaiting spec review)
**Started:** 2026-10-04
**Target:** generate-cli 1.4.0

---

## TL;DR

Atlas Cloud resells ~336 media models (image, video, audio) behind one async API: submit a job, poll a prediction id, download `outputs[]`. This spec adds Atlas as a fourth provider, adds an `audio` model kind, and introduces a shared **async job layer** so a slow job is resumed by id instead of resubmitted (a resubmit is a second paid job). The same layer fixes an existing defect: a Veo job that runs past 5 minutes today reports "timed out" and discards its operation id. Models reachable both directly and through Atlas keep one provider-neutral name; a hand-edited `config/routing.yaml` decides which provider serves each, based on a quoted price comparison.

## Background

| Fact | Source | Consequence |
|---|---|---|
| Atlas media endpoints are async: `POST /api/v1/model/generate{Image,Video,Audio}` returns `data.id`; `GET /api/v1/model/prediction/{id}` returns `data.status` (`processing`/`completed`/`failed`) and `data.outputs[]` | Atlas docs, per-model reference pages | Needs polling and a durable job id |
| No idempotency key; retrying a submit creates a second job, billed separately | Atlas docs | Submits must never be retried automatically |
| Outputs are kept 14 days by default | Atlas docs | Download immediately on completion |
| `POST /api/v1/model/calculate` quotes a price without generating | Atlas docs | Enables `--quote`, `--max-cost`, and the routing comparison |
| `POST /api/v1/model/uploadMedia` (multipart) returns a temporary URL | Atlas docs | Local reference files must be uploaded first |
| 429s carry no `Retry-After` / rate-limit headers | Atlas docs | Client-side backoff on polling |
| Model ids encode the task (`…/text-to-image` vs `…/edit`, `…/text-to-video` vs `…/image-to-video`) and input field names vary (`image`, `images`, `image_url`) | per-model reference pages; guide pages are stale and disagree | Per-model id variants and input mappings in YAML |
| Failure codes, e.g. `error_code: 1039` = moderation rejection | Atlas docs | Map to plain messages |
| Veo path: `maxWaitTime = 300000`, on expiry returns `success:false` and drops `operation` | `src/providers/google.ts:164-180` | Same double-billing risk, already shipped |
| No test files in the repo | `find . -name '*.test.ts'` | Tests ship with this change |

## Goals

1. `generate -m <atlas-model> ...` works for image, image edit (with `-r`), text-to-video, image-to-video, and audio (music, TTS).
2. No code path automatically resubmits a paid generation request.
3. Any async job that outlives `--wait` can be finished with `generate --resume <id>`, including Veo.
4. `--quote` reports the price of a request without generating; `--max-cost <usd>` refuses to submit above a limit.
5. One name per model regardless of provider; `config/routing.yaml` picks the provider; `--via <provider>` overrides per call.
6. A reproducible price comparison (`scripts/quote-table.ts`) supports each routing decision.
7. Existing model names, flags, defaults, and output paths keep working unchanged.

## Non-goals

- Speech-to-text and other text-output Atlas models.
- Atlas LLM endpoints.
- Automatic failover between providers.
- Webhooks (polling is sufficient for a CLI).
- Changing routing automatically from quotes; a person edits `routing.yaml`.

## Architecture

### Registry: provider-neutral names plus routing

- `Provider` gains `'atlas'`; `ModelKind` gains `'audio'`.
- Several provider YAMLs may declare the same canonical name (e.g. `nano-banana-2` in both `google.yaml` and `atlas.yaml`). The registry stores specs keyed by `(name, provider)`.
- `config/routing.yaml` maps a canonical name to its preferred provider:
  ```yaml
  # Edited by hand from scripts/quote-table.ts output. Flip rule: Atlas becomes
  # preferred when its quote is at least 10% below the direct list price.
  nano-banana-2: google
  veo-3.1: google
  ```
  A name declared by exactly one provider needs no entry. A name declared by several providers with no entry is a load-time error (no silent precedence).
- `--via <provider>` selects a specific provider's spec for that name; error if that provider does not declare it.
- `--list-models` shows each name once, with its active provider and the alternatives.

### Atlas YAML fields (in addition to the existing common fields)

| Field | Meaning |
|---|---|
| `id` | Atlas model id for the base task (text-to-image / text-to-video / audio) |
| `edit_id` | Image model id used when `-r` is given |
| `i2v_id` | Video model id used when `-r` is given |
| `inputs` | Field mapping, as for Replicate: `image` (single URL field), `images` (array field), `max_images`, `end_image`, `duration`, `resolution`, `aspect_ratio`, `seed`, `negative_prompt` |
| `resolution_values` | Map from CLI size presets to the model's enum |
| `direct_price` | (optional, on direct-provider specs) list price used by the quote table: `{ usd, unit, source, checked }` |

Every Atlas id is copied from the model's own reference page, not from guide examples.

### Async job layer (`src/utils/jobs.ts`)

```ts
interface JobRecord {
  id: string;              // provider's remote id (Atlas prediction id, Veo operation name)
  provider: Provider;
  model: string;           // canonical name
  kind: ModelKind;
  output: string;          // requested output path
  submittedAt: string;     // ISO
  quote?: { usd: number };
  status: 'pending' | 'completed' | 'failed';
  outputs?: string[];      // local paths once downloaded
  error?: { code?: number | string; message: string };
}
```

- Records live in `${XDG_CACHE_HOME:-~/.cache}/generate/jobs/<id>.json`, written **before** the first poll.
- `waitForJob(record, poller, { waitSeconds })` polls (2 s for image, 5 s for video and audio), backs off exponentially on 429 and network errors up to 30 s, and stops at the wait limit. Defaults: image 120 s, video 600 s, audio 300 s; `--wait <seconds>` overrides.
- **Completed:** download every output, update the record, print paths.
- **Failed:** update the record; print a plain message (`1039` → "rejected by content moderation"); exit 1.
- **Wait exceeded:** leave the record `pending`, print `Still running. Resume with: generate --resume <id>`, exit **75** (EX_TEMPFAIL).
- Submit requests are sent once. A network error on submit is reported as "submission state unknown" with guidance to check `generate --jobs` / the provider dashboard; it is never retried.
- Providers implement an optional `resume(record)` and `poll(record)` alongside `generate()`; Google's Veo path is refactored onto the layer, storing the operation name.

### New CLI surface (all additive)

| Flag | Behavior |
|---|---|
| `--via <provider>` | Use that provider's spec for the model |
| `--quote` | Print the quoted price and exit without generating (Atlas only; direct providers print `direct_price` if recorded, otherwise "no quote available") |
| `--max-cost <usd>` | Quote first (Atlas `/calculate`, or the spec's `direct_price` for direct providers); refuse to submit if the price exceeds the limit or neither source gives a price |
| `--wait <seconds>` | Override the poll deadline |
| `--no-wait` | Submit, write the record, print the id, exit 0 |
| `--resume <id>` | Continue polling a recorded job and download its outputs |
| `--jobs` | List job records (pending first) and exit |
| `--param key=value` | Repeatable; sets a model-specific top-level request field (Atlas) |

### Atlas provider (`src/providers/atlas.ts`)

- Base URL `https://api.atlascloud.ai/api/v1`; `Authorization: Bearer <key>`; key from `ATLASCLOUD_API_KEY` env, then macOS Keychain service `ATLASCLOUD_API_KEY`, via the existing `resolveApiKey`.
- Reference files: local paths uploaded through `uploadMedia`; http(s) URLs passed through.
- Request body: `model`, `prompt`, mapped `inputs`, then `--param` overrides, all top-level (Atlas does not wrap inputs).
- Output extension taken from the response URL or `Content-Type` (`.png/.jpg/.webp`, `.mp4`, `.mp3/.wav`), replacing the requested extension when they disagree, with a warning.

### Starter catalog (`config/models/atlas.yaml`)

Overlapping with direct providers: `nano-banana-2`, `nano-banana-pro`, `gpt-image-2`, `flux-2-pro`, `veo-3.1`, `veo-3.1-fast`.
Atlas-only: Seedream 5.0 Pro and 4.5 (image/edit), Ideogram 4, Kling 3.0 Pro, Seedance 2.x, Wan 2.7/3.0, Hailuo 2.3 (video), MiniMax Music 3.0, Suno chirp-v5, ElevenLabs v3 TTS (audio).
Each entry is verified against its reference page during implementation; any id that cannot be confirmed is left out rather than guessed.

### Price comparison (`scripts/quote-table.ts`)

For each canonical name declared by both Atlas and a direct provider: quote Atlas at a standard setting (image: 1K/2K, 16:9; video: 8 s 720p; audio: 30 s), read the direct spec's `direct_price`, and write a markdown table (model, Atlas quote, direct price, delta %, source and date). It does not edit `routing.yaml`.

## Phased plan

1. **Job layer + tests**, with Veo refactored onto it (fixes the shipped timeout defect on its own).
2. **Registry**: `atlas` provider, `audio` kind, multi-provider names, `routing.yaml`, `--via`, `--list-models` display.
3. **Atlas provider**: client, upload, image/edit, video/i2v, audio; `--quote`, `--max-cost`, `--param`, `--jobs`, `--no-wait`.
4. **Catalog + quote table**: populate `atlas.yaml`, record `direct_price` on overlapping direct specs, run the table, set `routing.yaml` by hand.
5. **Live smoke**: one cheap generation per modality (image, edit, i2v, audio), about USD 1 total, run only with the owner's go-ahead.

## Risks

| Risk | Mitigation |
|---|---|
| Double-billed jobs | Submit sent once; timeouts resume; tests assert no second POST |
| Stale or wrong Atlas model ids | Reference pages only; unverifiable ids omitted; smoke test per modality |
| `direct_price` drifts | Each carries `source` and `checked` date; table shows them |
| Breaking existing callers | All flags additive; existing names keep their current provider until `routing.yaml` changes |
| Exit code 75 surprises scripts that treat non-zero as failure | Documented; `--no-wait` available for scripted use |

## Success metrics

- Every goal above has a passing automated test, except live provider behavior, which is covered by the phase-5 smoke run.
- Zero duplicate submissions across the test suite and the smoke run (job records vs provider dashboard).
- Quote table produced and each `routing.yaml` entry traceable to a row.

## Decision log

| # | Decision | Why |
|---|---|---|
| 1 | Atlas lives in generate-cli, not a separate tool | One backend for every provider; callers keep one interface |
| 2 | Provider-neutral names + `routing.yaml` (not `atlas:`-prefixed names, not fallback chains) | Routing is a cost decision that belongs in the backend; fallback chains invite double-billing |
| 3 | Atlas preferred only where quoted ≥10% cheaper | "Cheaper" was the reason for adding Atlas; make it evidence, not assumption |
| 4 | Shared job layer also used by Veo | Same defect class already shipped; fix at the shared point |
| 5 | Routing edited by hand from the table | Keeps a person accountable for spend-affecting changes |

## Appendix B: Files expected to change

- New: `src/providers/atlas.ts`, `src/utils/jobs.ts`, `config/models/atlas.yaml`, `config/routing.yaml`, `scripts/quote-table.ts`, `src/**/*.test.ts`
- Changed: `src/types.ts`, `src/config/models.ts`, `src/providers/index.ts`, `src/providers/google.ts`, `src/cli.ts`, `config/models/{google,openai,replicate}.yaml` (`direct_price` on overlapping models), `README.md`, `package.json` (version)
