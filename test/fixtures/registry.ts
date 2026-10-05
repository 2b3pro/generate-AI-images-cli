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
