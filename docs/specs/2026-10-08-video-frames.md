# Extract Stills, Thumbnails, Film Strips and Contact Sheets from Video

**Status:** Shipped 2026-10-08 in generate-cli 1.7.0
**Started:** 2026-10-08
**Target:** generate-cli 1.7.0

---

## TL;DR

Reference stills often come from video: the last frame of a clip to extend it, or a good moment from footage to use as an identity or style reference. Today that means a separate ffmpeg command, and `--thumbnail` on a video job silently does nothing. This spec adds a small frame layer to generate (`src/frames.ts`) with five surfaces: `--thumbnail` and `--filmstrip` on video jobs, standalone `--frame <video>@<t>` and `--sheet <video>` modes that exit without generating, and a `--ref <role>=<video>@<t>` shortcut that extracts and uses a frame in one step. The Media skill then uses these in its Video and Create workflows, including looking at a film strip of every clip before delivering it.

## Background

| Fact | Source | Consequence |
|---|---|---|
| generate already shells out to ffprobe, guarded by `Bun.which` | `src/cost.ts:13-24` (`clipLength`) | ffmpeg is not a new kind of dependency; the same guard pattern applies |
| `--thumbnail [size]` exists, but `postProcess` skips every file that is not png/jpg/webp | `src/postprocess.ts:15` | On a video job `--thumbnail` produces nothing and says nothing |
| `generateThumbnail` falls back to Quick Look for non-images, but video never reaches it | `src/utils/thumbnail.ts:27-33` | The fallback gives no control over which frame |
| Refs carry roles; `start`/`end` mean first/last frame of the generated video | `src/refs.ts:5-6`, `parseRefArg` at `src/refs.ts:15` | Extending a clip needs the exact last frame of the previous one as `start` |
| Early-exit modes already exist (`--list-models`, `--jobs`, `--voices`) | `src/cli.ts:46`, `:76`, `:93` | `--frame` and `--sheet` fit the same pattern |
| Provenance is stamped with exiftool: CreatorTool plus IPTC Digital Source Type | `src/utils/provenance.ts` | Frames from a generated clip can inherit the clip's stamp; frames from other video cannot |
| Local ffmpeg 9.0.2 has `select`, `scale`, `tile`, `thumbnail`, `blurdetect`, `tonemap`, `colorspace`; **no** `drawtext` (no libfreetype) and **no** `zscale`/`libplacebo` | `ffmpeg -filters`, `-buildconf` on 2026-10-08 | Timestamps must be drawn with sharp, not ffmpeg; HDR tone mapping is not available |
| `sharp` is already a dependency | `package.json` | Tiling and labelling sheets needs nothing new |
| A seek past the last frame makes ffmpeg exit 0 and write nothing | Phase 0, 2026-10-08 | Remove the target first, check it exists after; refuse times at or past the duration |
| PAI Actions `A_VIDEO_POSTER` and `A_EXTRACT_FRAMES` exist; only `P_VIDEO_DOWNLOAD` uses them | `$PAI_DIR/PAI/ACTIONS/`, `$PAI_DIR/PAI/PIPELINES/P_VIDEO_DOWNLOAD/PIPELINE.md` | Left as they are; no last-frame, sheet, or sharpness support there |

## Goals

| # | Goal | Concrete |
|---|---|---|
| G1 | `--thumbnail` works on video jobs | `generate -m <video-model> "..." --thumbnail` writes `<clip>_thumb.png`; today it writes nothing |
| G2 | A generated clip can be looked at, not only probed | `--filmstrip [n]` on a video job writes one PNG row of n frames (default 6), each labelled with its timestamp |
| G3 | One still from any video without generating | `generate --frame clip.mp4@<t> [-o still.png]` writes a PNG and exits 0 with no model or API key; `<t>` is `first`, `last`, seconds (`12.5`), `HH:MM:SS[.ms]`, or `N%` |
| G4 | A sheet to choose a moment from | `generate --sheet clip.mp4 [--every <s> \| --scenes] [--strip]` writes a labelled grid (or one row with `--strip`) and exits |
| G5 | Extend a clip in one command | `--ref start=prev.mp4@last` extracts the exact final frame, saves it beside the output, and uses it as the `start` ref |
| G6 | Callers can find derived files | `--json` lists thumbnails, strips, sheets and extracted ref frames under a new `frames` key, never in `outputs` |
| G7 | No ffmpeg, no harm | Without ffmpeg, only frame features fail, with a message naming the missing binary; all other generation is unaffected |
| G8 | Media uses it | `Skills/Media/Workflows/Video.md` gains "extend from last frame" and "view a film strip before delivering"; `Create.md` gains "still from a clip as reference" (`--sheet`, then `--frame`) |

## Non-goals

| # | Out of scope |
|---|---|
| N1 | HDR tone mapping. This ffmpeg build has no `zscale`; detect HDR and warn instead (R1) |
| N2 | Choosing a frame for a ref automatically. A video ref always names `first`, `last`, or a time |
| N3 | Changing the PAI Actions `A_VIDEO_POSTER` / `A_EXTRACT_FRAMES` |
| N4 | GIF or animated previews |
| N5 | A separate `Skills/Media/Tools/Frames.ts` (see Decision log) |

## Architecture

### New: `src/frames.ts`

```
parseFrameSpec("clip.mp4@last")  -> { path: "clip.mp4", at: { kind: "last" } }
probeVideo(path)                 -> { duration, width, height, transfer }   // moves clipLength here from cost.ts
extractFrame(path, at, outPng)   -> outPng
sampleTimes(probe, { every | count | scenes }) -> number[]
makeSheet(path, times, { strip, cols, width }, outPng) -> outPng   // ffmpeg grabs, sharp tiles + labels
```

ffmpeg recipes (each confirmed in Phase 0 before use):

| Need | Recipe |
|---|---|
| Frame at `t` | `ffmpeg -ss <t> -i <in> -frames:v 1 <out>.png` |
| Last frame | `ffmpeg -sseof -1 -i <in> -update 1 <out>.png` (each decoded frame overwrites; the last one remains) |
| `N%` | duration from `probeVideo`, then the frame-at-`t` recipe |
| Scene changes | `select='gt(scene,0.3)',showinfo` with `-fps_mode vfr`; times parsed from `showinfo` `pts_time` |
| Sheet / strip | grab each sampled time as a PNG, then sharp: resize, composite an SVG timestamp label, tile into a grid or one row |

### Wiring

| Surface | Where |
|---|---|
| `--frame`, `--sheet` early-exit modes | `src/cli.ts`, next to the `--voices` block |
| `--thumbnail` and `--filmstrip` for video outputs | `src/postprocess.ts` (video branch before the image-extension filter) |
| `<video>@<t>` in `--ref` | `parseRefArg` in `src/refs.ts`; extraction runs before validation, so ref rules see a PNG |
| `frames` key | `ResultJson` in `src/run.ts` |

### Provenance

- Thumbnails and strips of a clip generate just made carry that clip's stamp.
- Frames taken from any other video get `CreatorTool` only. generate cannot know where that video came from, so it writes no Digital Source Type (Q3).

### Unchanged

| Component | Location |
|---|---|
| Image `--thumbnail` path (sharp) | `src/utils/thumbnail.ts` |
| Ref role rules and validation | `validateRefs` in `src/refs.ts` |
| PAI frame Actions | `$PAI_DIR/PAI/ACTIONS/A_VIDEO_POSTER`, `A_EXTRACT_FRAMES` |

## Phased plan

| Phase | Deliverable | Validates | Estimate |
|---|---|---|---|
| 0 | Spike on one generated clip and one iPhone clip: frame-at-`t`, `@last` exactness against `ffprobe -count_frames`, scene `showinfo` parsing, sharp label rendering, HDR detection from `color_transfer` | R1, R2, R4; Q1 | 1 hour |
| 1 | `src/frames.ts`; `--thumbnail` on video; `--filmstrip` | G1, G2, G6, G7 | half day |
| 2 | `--frame` and `--sheet` modes | G3, G4 | half day |
| 3 | `--ref <role>=<video>@<t>` | G5 | 2 hours |
| 4 | Media `Video.md` and `Create.md` updates | G8 | 1 hour |

## Open questions

| # | Question | Why it matters |
|---|---|---|
| Q1 | Which frame does `--thumbnail` take from a video: first, middle, or ffmpeg's `thumbnail` pick? | The first frame of an image-to-video job is the start ref itself, so it shows little [Answered 2026-10-08: the middle frame] |
| Q2 | How is `@` in a filename (`clip@2x.mp4`) told apart from a frame selector? | Proposed rule: `@<t>` is a selector only when the text after the last `@` parses as a time and the whole string is not an existing file [Answered 2026-10-08: that rule, plus the part before `@` must end in a video extension] |
| Q3 | What provenance should a frame from a non-generated video carry? | A wrong Digital Source Type misdescribes a real photo as AI-made [Answered 2026-10-08: none from generate; only thumbnails and strips of a generation's own outputs are stamped] |
| Q4 | Should `--frame` accept several times in one call (`@1,5,9`)? | Saves round trips when picking references from a sheet [Deferred: not built] |

## Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Frames from HDR clips (iPhone HLG, Dolby Vision) look flat and grey | High for phone footage | Medium | Read `color_transfer` (`arib-std-b67`, `smpte2084`) and warn; tone mapping deferred (N1) |
| R2 | Text labels render poorly or not at all in sharp's SVG path | Low | Low | Phase 0 check; fall back to unlabelled tiles plus times in `--json` |
| R3 | Merge conflict with the in-flight Omni change (`cli.ts`, `refs.ts`, `run.ts`, `cost.ts`) | High if built now | Medium | Decided: build after Omni is committed |
| R4 | `@last` lands one frame early on variable-frame-rate or B-frame streams | Medium | High for clip extension | Phase 0: compare against a full decode count |

## Success metrics

| # | Metric | Baseline | Target | Source |
|---|---|---|---|---|
| M1 | Video jobs with `--thumbnail` that produce a thumbnail | 0% (silently skipped) | 100% when ffmpeg is present | test suite |
| M2 | Clips Nova delivers after viewing a film strip | 0 (ffprobe only) | every clip delivered through Media | `Workflows/Video.md` step |

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-10-08 | Frame extraction lives in generate, not in `Skills/Media/Tools/Frames.ts` | generate already uses ffprobe and owns `--thumbnail`; output-side features need the code anyway, so one implementation serves both |
| 2026-10-08 | Build after the Omni change is committed | That change edits the same four source files |
| 2026-10-08 | Video refs need an explicit `first`, `last`, or time | `last` is a fixed continuation point; any other moment should be chosen, ideally from a sheet, before money is spent |
| 2026-10-08 | Labels are drawn with sharp, not ffmpeg `drawtext` | The local ffmpeg build has no libfreetype |
| 2026-10-08 | Phase 0 passed: `-sseof -1 -update 1` gives the exact last frame on a B-frame clip, a 0.5 s clip and a variable-frame-rate clip; scene cuts, HLG detection and sharp labels all work | Measured on frame-coded synthetic clips (frame N has luma 16+4N) |
| 2026-10-08 | `cost.ts` keeps its own `clipLength` | Moving it would make pricing throw when ffprobe is missing instead of falling back; no simplification gained |
| 2026-10-08 | Sheet times are cut down to the centisecond the label shows | A label is then exactly the `--frame` time that gives back that tile |
| 2026-10-08 | Media's `Video.ts` asks for `--filmstrip` on every paid run | Doctrine 5: a clip is viewed, not only probed, before delivery |

---

## Appendix B: Files expected to change

| Path | Change type |
|---|---|
| `src/frames.ts` | new |
| `test/frames.test.ts` | new |
| `src/cli.ts` | edit (flags, early-exit modes) |
| `src/postprocess.ts` | edit (video branch) |
| `src/refs.ts` | edit (`@<t>` parsing) |
| `src/run.ts` | edit (`frames` in `ResultJson`) |
| `src/cost.ts` | unchanged (see Decision log) |
| `README.md` | edit |
| `test/cli.test.ts`, `test/postprocess.test.ts` | edit |
| `$PAI_DIR/Skills/Media/Tools/Video.ts`, `video.test.ts`, `ISA.md` (ISC-27), `SKILL.md` | edit (PAI repo) |
| `$PAI_DIR/Skills/Media/Workflows/Video.md`, `Create.md` | edit (PAI repo) |
