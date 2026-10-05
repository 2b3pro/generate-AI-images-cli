#!/usr/bin/env bun
import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
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
import pkg from '../package.json';

// Load config/models/*.yaml up front so a broken or missing config fails with
// a readable message instead of a stack trace from deep inside option parsing.
try {
  loadModelRegistry();
} catch (err) {
  console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
}

const program = new Command();

program
  .name('generate')
  .version(pkg.version, '-v, --version', 'Output current version')
  // Commander only accepts one short flag per option; keep -V as a hidden alias.
  .addOption(new Option('-V').hideHelp())
  .on('option:V', () => {
    console.log(pkg.version);
    process.exit(0);
  })
  .description(`AI Image & Video Generation CLI (v${pkg.version}) - Generate images and videos using Gemini (Nano Banana & Veo), OpenAI, Flux, and more`)
  .addHelpText('beforeAll', chalk.bold.cyan(`\n  generate v${pkg.version}\n`));

// Handle --list-models before requiring other options
if (process.argv.includes('--list-models')) {
  console.log(chalk.bold('\nAvailable Models:'));
  console.log(chalk.dim(`  (from ${modelsConfigDir()})\n`));
  const models = listModels();

  const byProvider = models.reduce((acc, entry) => {
    if (!acc[entry.provider]) acc[entry.provider] = [];
    acc[entry.provider].push(entry);
    return acc;
  }, {} as Record<string, typeof models>);

  for (const [provider, providerModels] of Object.entries(byProvider)) {
    console.log(chalk.cyan(`  ${provider.toUpperCase()}:`));
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
    console.log();
  }
  process.exit(0);
}

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

const MODEL_NAMES = listModelSpecs().map((m) => m.name).join(', ');

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
    `Model to use (see --list-models). One of: ${MODEL_NAMES}`,
    DEFAULT_OPTIONS.model
  )
  .option('-p, --prompt <text>', 'Generation prompt (alternative to positional argument)')
  .option(
    '-s, --size <size>',
    'Image size: 512|1K|2K|4K (Google; 512 is nano-banana-2 only), WxH (gpt-image-2 and newer accept any dimensions divisible by 16, longest edge <= 3840), or a fixed preset',
    (val) => {
      const presets = ['512', '1K', '2K', '4K', 'auto'];
      if (presets.includes(val) || /^\d+x\d+$/.test(val)) return val;
      throw new Error(`Invalid size "${val}". Use 512|1K|2K|4K, auto, or WxH (e.g. 1088x1920).`);
    }
  )
  .addOption(
    new Option('-a, --aspect-ratio <ratio>', 'Aspect ratio (default: 16:9)')
      .choices(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'])
      .default(DEFAULT_OPTIONS.aspectRatio)
  )
  .option('-o, --output <path>', 'Output file path')
  .option('-r, --reference <path...>', 'Reference image(s) for style/composition or image-to-video (repeatable)')
  .option('--duration <seconds>', 'Video duration in seconds: 4, 6, or 8 (Veo models)', parseInt)
  .option('--resolution <res>', 'Video/image resolution: 720p|1080p|4k (video; 1080p/4k force 8s), 512|1K|2K|4K (Google image)')
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
    new Option('-q, --quality <quality>', 'Image quality (OpenAI models; standard/hd map to medium/high; xhigh/max are GPT Image 2.5 only)')
      .choices(['standard', 'hd', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])
      .default(DEFAULT_OPTIONS.quality)
  )
  .addOption(
    new Option('--style <style>', 'Image style')
      .choices(['vivid', 'natural'])
      .default(DEFAULT_OPTIONS.style)
  )
  .option('--num-images <number>', 'Number of images to generate', parseInt, DEFAULT_OPTIONS.numImages)
  .option('--api', '(deprecated, no-op) Gemini API is now the only image route')
  .option('--list-models', 'List available models and exit')
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

  ${chalk.dim('# Highest-quality OpenAI generation (GPT Image 2.5 Sunburst)')}
  $ generate -m gpt-image-2.5-sunburst "Abstract digital art" -q high

  ${chalk.dim('# Fast, lower-cost OpenAI generation (GPT Image 2.5 Flare)')}
  $ generate -m gpt-image-2.5-flare "A cute robot mascot" --transparent

  ${chalk.dim('# Edit an existing image with OpenAI')}
  $ generate -m gpt-image-2.5-sunburst "Add a hat to the person" -r ./photo.png

  ${chalk.dim('# Generate with multiple references (Gemini)')}
  $ generate "Blend these styles" -r style1.png -r style2.png

  ${chalk.dim('# Generate 5 variations')}
  $ generate "Abstract art" --variations 5 -o ~/Downloads/abstract.png

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
  ATLASCLOUD_API_KEY                Required for Atlas models

${chalk.bold('Model Configuration:')}
  Models, aliases, API ids, and retired-model notices are defined in
  config/models/<provider>.yaml. Edit those files to add or update models;
  set GENERATE_MODELS_DIR to point at a different directory.

${chalk.dim('Note on retired models: Imagen 3, Imagen 3 Fast, Imagen 4, and Veo 2.0 were retired by Google and replaced by Gemini 3.x Nano Banana and Veo 3.1.')}
`);

program.parse();
