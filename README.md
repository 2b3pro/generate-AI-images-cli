# img-gen-cli

AI Image Generation CLI — generate images using Gemini, OpenAI, Flux, and more from your terminal.

## Installation

```bash
bun install
bun run build
```

To install globally:
```bash
bun link
```

## Usage

```bash
generate -p "A serene mountain landscape at sunset"
```

### Options

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | Image generation prompt (required) |
| `-m, --model <model>` | Model to use (default: `nano-banana-pro`) |
| `-a, --aspect-ratio <ratio>` | Aspect ratio: `1:1`, `16:9`, `9:16`, `4:3`, etc. |
| `-s, --size <size>` | Image size: `1K`, `2K`, `4K`, or specific dimensions |
| `-o, --output <path>` | Output file path |
| `-r, --reference-image <path>` | Reference image(s) for style (repeatable) |
| `--transparent` | Enable transparent background |
| `--remove-bg` | Remove background after generation |
| `--add-bg <hex>` | Add background color to transparent image |
| `-n, --negative-prompt <text>` | Things to avoid in generation |
| `--thumbnail [size]` | Generate thumbnail (default: 256px) |
| `--variations <n>` | Generate N variations (1-10) |
| `--seed <number>` | Random seed for reproducibility |
| `-q, --quality <quality>` | Image quality: `standard`, `hd` |
| `--style <style>` | Image style: `vivid`, `natural` |
| `--list-models` | List all available models |

### Models

```bash
generate --list-models
```

**Google (Gemini/Imagen)**
- `nano-banana-pro` (default)
- `nano-banana`
- `imagen-4`
- `imagen-3`
- `imagen-3-fast`

**OpenAI**
- `gpt-image-1`
- `gpt-image-1.5`

**Replicate (Flux)**
- `flux`
- `flux-schnell`
- `flux-pro`

### Examples

```bash
# Generate with default model
generate -p "A serene mountain landscape at sunset"

# Generate with OpenAI in HD quality
generate -m gpt-image-1 -p "Abstract digital art" -q hd

# Generate with transparent background
generate -m gpt-image-1 -p "A cute robot mascot" --transparent

# Edit an existing image
generate -m gpt-image-1.5 -p "Add a hat to the person" -r ./photo.png

# Generate with cinematic aspect ratio
generate -m imagen-4 -p "Cinematic scene" -a 21:9

# Generate 5 variations
generate -p "Abstract art" --variations 5 -o ~/Downloads/abstract.png
```

## Environment Variables

| Variable | Required for |
|----------|--------------|
| `GOOGLE_API_KEY` | Gemini/Imagen models |
| `OPENAI_API_KEY` | GPT-Image models |
| `REPLICATE_API_TOKEN` | Flux models |
| `REMOVE_BG_API_KEY` | `--remove-bg` feature |

## License

MIT
