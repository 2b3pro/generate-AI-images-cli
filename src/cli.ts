#!/usr/bin/env bun
import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getProviderForModel, listModels } from './providers';
import { removeBackground, addBackgroundColor } from './utils/background';
import { generateThumbnail } from './utils/thumbnail';
import type { GenerateOptions, Model, AspectRatio } from './types';
import { DEFAULT_OPTIONS, isVideoModel, resolveModel } from './types';
import pkg from '../package.json';

const program = new Command();

program
  .name('generate')
  .version(pkg.version, '-v, -V, --version', 'Output current version')
  .description(`AI Image & Video Generation CLI (v${pkg.version}) - Generate images and videos using Gemini (Nano Banana & Veo), OpenAI, Flux, and more`)
  .addHelpText('beforeAll', chalk.bold.cyan(`\n  generate v${pkg.version}\n`));

// Handle --list-models before requiring other options
if (process.argv.includes('--list-models')) {
  console.log(chalk.bold('\nAvailable Models:\n'));
  const models = listModels();

  const byProvider = models.reduce((acc, { model, provider }) => {
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(model);
    return acc;
  }, {} as Record<string, string[]>);

  for (const [provider, providerModels] of Object.entries(byProvider)) {
    console.log(chalk.cyan(`  ${provider.toUpperCase()}:`));
    for (const model of providerModels) {
      const isVideo = isVideoModel(model);
      const tag = isVideo ? chalk.yellow(' [VIDEO]') : chalk.dim(' [IMAGE]');
      console.log(`    - ${model}${tag}`);
    }
    console.log();
  }
  process.exit(0);
}

async function readStdinIfAvailable(hasCliPrompt: boolean): Promise<string> {
  if (process.stdin.isTTY) return '';

  return new Promise((resolve) => {
    let data = '';
    let timer: NodeJS.Timeout | null = null;

    const done = () => {
      if (timer) clearTimeout(timer);
      resolve(data.trim());
    };

    if (hasCliPrompt) {
      // If CLI prompt was already provided, wait at most 50ms for initial stdin data
      timer = setTimeout(() => {
        process.stdin.pause();
        done();
      }, 50);
    }

    process.stdin.on('data', (chunk) => {
      data += chunk.toString();
      if (timer) {
        clearTimeout(timer);
        timer = setTimeout(done, 50);
      }
    });

    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.resume();
  });
}

program
  .argument('[prompt...]', 'Generation prompt')
  .option(
    '-m, --model <model>',
    'Model to use: nano-banana-2 (default), nano-banana-pro, nano-banana-2-lite, nano-banana, veo-3.1, veo-3.1-lite, flux, flux-schnell, flux-pro, gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini',
    DEFAULT_OPTIONS.model
  )
  .option('-p, --prompt <text>', 'Generation prompt (alternative to positional argument)')
  .option(
    '-s, --size <size>',
    'Image size: 1K|2K|4K (Google), WxH (gpt-image-2 accepts any dimensions divisible by 16, longest edge <= 3840), or a fixed preset',
    (val) => {
      const presets = ['1K', '2K', '4K', 'auto'];
      if (presets.includes(val) || /^\d+x\d+$/.test(val)) return val;
      throw new Error(`Invalid size "${val}". Use 1K|2K|4K, auto, or WxH (e.g. 1088x1920).`);
    }
  )
  .addOption(
    new Option('-a, --aspect-ratio <ratio>', 'Aspect ratio (default: 16:9)')
      .choices(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'])
      .default(DEFAULT_OPTIONS.aspectRatio)
  )
  .option('-o, --output <path>', 'Output file path')
  .option('-r, --reference <path...>', 'Reference image(s) for style/composition or image-to-video (repeatable)')
  .option('--duration <seconds>', 'Video duration in seconds: 4 or 8 (Veo models)', parseInt)
  .option('--resolution <res>', 'Video/image resolution: 720p|1080p (video), 1K|2K|4K (Google image)')
  .option('--fps <number>', 'Video frame rate (e.g. 24, 30)', parseInt)
  .option('--transparent', 'Enable transparent background (where supported)')
  .option('--remove-bg', 'Remove background after generation using remove.bg API')
  .option('--add-bg <hex>', 'Add background color to transparent image (e.g., "#EAE9DF")')
  .option('-n, --negative-prompt <text>', 'Negative prompt (things to avoid)')
  .option('--thumbnail [size]', 'Generate thumbnail (default: 256px)', parseInt)
  .option('--variations <n>', 'Generate N variations (1-10)', (val) => {
    const n = parseInt(val);
    if (isNaN(n) || n < 1 || n > 10) throw new Error('Variations must be 1-10');
    return n;
  })
  .option('--seed <number>', 'Random seed for reproducibility', parseInt)
  .option('--steps <number>', 'Number of inference steps', parseInt)
  .option('--guidance <number>', 'Guidance scale', parseFloat)
  .addOption(
    new Option('-q, --quality <quality>', 'Image quality (OpenAI models; standard/hd map to medium/high)')
      .choices(['standard', 'hd', 'low', 'medium', 'high', 'auto'])
      .default(DEFAULT_OPTIONS.quality)
  )
  .addOption(
    new Option('--style <style>', 'Image style')
      .choices(['vivid', 'natural'])
      .default(DEFAULT_OPTIONS.style)
  )
  .option('--num-images <number>', 'Number of images to generate', parseInt, DEFAULT_OPTIONS.numImages)
  .option('--api', 'Use Gemini API instead of CLI for nanobanana models')
  .option('--list-models', 'List available models and exit')
  .action(async (promptArgs: string[], opts) => {
    const cliPrompt = promptArgs.length > 0 ? promptArgs.join(' ') : (opts.prompt || '');
    const stdinPrompt = await readStdinIfAvailable(Boolean(cliPrompt));

    // Combine: stdin + CLI with XML-like structure for clarity
    let prompt: string;
    if (stdinPrompt && cliPrompt) {
      prompt = `<prompt>\n${stdinPrompt}\n</prompt>\n\n<additional_guidance>\n${cliPrompt}\n</additional_guidance>`;
    } else {
      prompt = stdinPrompt || cliPrompt;
    }

    if (!prompt) {
      console.error(chalk.red('Error: Prompt is required. Usage: generate "your prompt" or via stdin.'));
      process.exit(1);
    }

    // Resolve model name & aliases, check obsolete models
    let resolvedModel: Model;
    try {
      resolvedModel = resolveModel(opts.model);
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    const isVideo = isVideoModel(resolvedModel);

    // Determine output path
    let defaultOut = isVideo ? DEFAULT_OPTIONS.videoOutput : DEFAULT_OPTIONS.output;
    let outputPath = opts.output || defaultOut;

    if (isVideo && /\.(png|jpg|jpeg|webp)$/i.test(outputPath)) {
      outputPath = outputPath.replace(/\.(png|jpg|jpeg|webp)$/i, '.mp4');
    }

    const options: GenerateOptions = {
      model: resolvedModel,
      prompt,
      size: opts.size,
      resolution: opts.resolution,
      duration: opts.duration,
      fps: opts.fps,
      aspectRatio: opts.aspectRatio as AspectRatio,
      output: outputPath,
      referenceImages: opts.reference, // Commander collects into array
      transparent: opts.transparent,
      removeBg: opts.removeBg,
      addBg: opts.addBg,
      negativePrompt: opts.negativePrompt,
      thumbnail: opts.thumbnail,
      variations: opts.variations,
      seed: opts.seed,
      steps: opts.steps,
      guidance: opts.guidance,
      quality: opts.quality,
      style: opts.style,
      numImages: opts.numImages,
      useApi: opts.api,
    };

    const variationCount = isVideo ? 1 : (options.variations || 1);
    const isMultiple = variationCount > 1;
    const baseOutput = outputPath;
    const ext = baseOutput.match(/\.(png|jpg|jpeg|webp|mp4)$/i)?.[0] || (isVideo ? '.mp4' : '.png');
    const basePath = baseOutput.replace(new RegExp(`\\${ext}$`, 'i'), '');

    const spinner = ora({
      text: isVideo
        ? `Generating video with ${chalk.cyan(options.model)}...`
        : isMultiple
        ? `Generating ${variationCount} variations with ${chalk.cyan(options.model)}...`
        : `Generating image with ${chalk.cyan(options.model)}...`,
      spinner: 'dots',
    }).start();

    // Wire live status updates into spinner
    options.onProgress = (status: string) => {
      spinner.text = status;
    };

    try {
      const provider = getProviderForModel(options.model);
      const generatedPaths: string[] = [];

      for (let i = 1; i <= variationCount; i++) {
        const itemOutput = isMultiple ? `${basePath}-v${i}${ext}` : baseOutput;

        if (isMultiple) {
          spinner.text = `Generating variation ${i}/${variationCount}...`;
        }

        // Generate the image or video
        const result = await provider.generate({ ...options, output: itemOutput });

        if (!result.success) {
          spinner.fail(chalk.red(`Generation failed: ${result.error}`));
          process.exit(1);
        }

        // Post-processing only applies to images
        if (!isVideo && result.outputPath) {
          if (options.removeBg) {
            spinner.text = isMultiple
              ? `Removing background (${i}/${variationCount})...`
              : 'Removing background...';
            await removeBackground(result.outputPath, result.outputPath);
          }

          if (options.addBg) {
            spinner.text = 'Adding background color...';
            await addBackgroundColor(result.outputPath, result.outputPath, options.addBg);
          }

          if (options.thumbnail) {
            spinner.text = 'Generating thumbnail...';
            const size = typeof options.thumbnail === 'number' ? options.thumbnail : 256;
            await generateThumbnail(result.outputPath, { size });
          }
        }

        generatedPaths.push(result.outputPath!);
      }

      spinner.succeed(chalk.green(
        isVideo
          ? 'Video generated successfully!'
          : isMultiple
          ? `Generated ${variationCount} variations successfully!`
          : 'Image generated successfully!'
      ));

      // Output summary
      console.log();
      console.log(chalk.dim('─'.repeat(50)));
      if (isMultiple) {
        console.log(chalk.bold('  Outputs:'));
        for (const path of generatedPaths) {
          console.log(`    ${chalk.cyan(path)}`);
        }
      } else {
        console.log(chalk.bold('  Output:'), chalk.cyan(generatedPaths[0]));
      }
      console.log(chalk.bold('  Model:'), options.model);
      console.log(chalk.dim('─'.repeat(50)));
      console.log();

      // Open the first media output on macOS
      if (process.platform === 'darwin' && generatedPaths[0]) {
        const { spawn } = await import('child_process');
        spawn('open', [generatedPaths[0]], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (error) {
      spinner.fail(chalk.red(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

// Custom help
program.addHelpText('after', `

${chalk.bold('Examples:')}
  ${chalk.dim('# Generate image with default (nano-banana-2: Gemini 3.1 Flash Image)')}
  $ generate "A serene mountain landscape at sunset"

  ${chalk.dim('# Generate highest-quality image with Gemini 3 Pro')}
  $ generate -m nano-banana-pro "Intricate architectural diagram of a futuristic space habitat"

  ${chalk.dim('# Ultra-fast sub-2s image generation (Gemini 3.1 Flash Lite Image)')}
  $ generate -m nano-banana-2-lite "Minimalist logo of a golden owl"

  ${chalk.dim('# Cinematic 4K/1080p video generation with Veo 3.1')}
  $ generate -m veo-3.1 "A drone flying smoothly through a vibrant neon cyberpunk metropolis at night"

  ${chalk.dim('# Rapid video generation with Veo 3.1 Lite (portrait 9:16 for mobile)')}
  $ generate -m veo-3.1-lite "Raindrops rippling on a puddle in slow motion" -a 9:16

  ${chalk.dim('# Image-to-video with Veo 3.1')}
  $ generate -m veo-3.1 "Bring this painting to life with gentle ambient motion" -r ./painting.png

  ${chalk.dim('# Generate with OpenAI in HD quality')}
  $ generate -m gpt-image-1 "Abstract digital art" -q hd

  ${chalk.dim('# Generate with transparent background')}
  $ generate -m gpt-image-1 "A cute robot mascot" --transparent

  ${chalk.dim('# Edit an existing image (gpt-image-1.5)')}
  $ generate -m gpt-image-1.5 "Add a hat to the person" -r ./photo.png

  ${chalk.dim('# Generate with multiple references (Gemini)')}
  $ generate "Blend these styles" -r style1.png -r style2.png

  ${chalk.dim('# Generate 5 variations')}
  $ generate "Abstract art" --variations 5 -o ~/Downloads/abstract.png

${chalk.bold('Stdin Support:')}
  ${chalk.dim('# Pipe prompt from file or other tools')}
  $ cat prompt.txt | generate
  $ claude "describe a scene" | generate

  ${chalk.dim('# Combine stdin with CLI args (stdin + refinement)')}
  $ cat base-prompt.txt | generate "make it cyberpunk"
  $ echo "A dragon" | generate "photorealistic, 8k, cinematic lighting"

${chalk.bold('Environment Variables:')}
  GOOGLE_API_KEY / GEMINI_API_KEY   Required for Gemini/Veo models
  OPENAI_API_KEY                    Required for GPT-Image models
  REPLICATE_API_TOKEN               Required for Flux models
  REMOVE_BG_API_KEY                 Required for --remove-bg feature

${chalk.dim('Note on retired models: Imagen 3, Imagen 3 Fast, Imagen 4, and Veo 2.0 were retired by Google and replaced by Gemini 3.x Nano Banana and Veo 3.1.')}
`);

program.parse();
