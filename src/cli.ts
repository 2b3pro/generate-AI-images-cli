#!/usr/bin/env bun
import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getProviderForModel, listModels } from './providers';
import { removeBackground, addBackgroundColor } from './utils/background';
import { generateThumbnail } from './utils/thumbnail';
import type { GenerateOptions, Model, AspectRatio } from './types';
import { DEFAULT_OPTIONS } from './types';

const program = new Command();

program
  .name('generate')
  .description('AI Image Generation CLI - Generate images using Gemini, OpenAI, Flux, and more')
  .version('1.0.0');

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
      console.log(`    - ${model}`);
    }
    console.log();
  }
  process.exit(0);
}

program
  .option('-m, --model <model>', 'Model to use: nano-banana-pro (default), nano-banana, imagen-4, imagen-3, imagen-3-fast, flux, flux-schnell, flux-pro, gpt-image-1, gpt-image-1.5', DEFAULT_OPTIONS.model)
  .requiredOption('-p, --prompt <text>', 'Image generation prompt (quote if contains spaces)')
  .addOption(
    new Option('-s, --size <size>', 'Image size/resolution')
      .choices(['1K', '2K', '4K', '1024x1024', '1024x1792', '1792x1024', '1536x1536', '1024x1536', '1536x1024'])
  )
  .addOption(
    new Option('-a, --aspect-ratio <ratio>', 'Aspect ratio (default: 16:9)')
      .choices(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'])
      .default(DEFAULT_OPTIONS.aspectRatio)
  )
  .option('-o, --output <path>', 'Output file path', DEFAULT_OPTIONS.output)
  .option('-r, --reference-image <path...>', 'Reference image(s) for style/composition (repeatable)')
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
    new Option('-q, --quality <quality>', 'Image quality (OpenAI models)')
      .choices(['standard', 'hd'])
      .default(DEFAULT_OPTIONS.quality)
  )
  .addOption(
    new Option('--style <style>', 'Image style')
      .choices(['vivid', 'natural'])
      .default(DEFAULT_OPTIONS.style)
  )
  .option('--num-images <number>', 'Number of images to generate', parseInt, DEFAULT_OPTIONS.numImages)
  .option('--list-models', 'List available models and exit')
  .action(async (opts) => {
    const options: GenerateOptions = {
      model: opts.model as Model,
      prompt: opts.prompt,
      size: opts.size,
      aspectRatio: opts.aspectRatio as AspectRatio,
      output: opts.output,
      referenceImages: opts.referenceImage, // Commander collects into array
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
    };

    const variationCount = options.variations || 1;
    const isMultiple = variationCount > 1;
    const baseOutput = options.output || DEFAULT_OPTIONS.output;
    const basePath = baseOutput.replace(/\.(png|jpg|jpeg|webp)$/i, '');
    const ext = baseOutput.match(/\.(png|jpg|jpeg|webp)$/i)?.[0] || '.png';

    const spinner = ora({
      text: isMultiple
        ? `Generating ${variationCount} variations with ${chalk.cyan(options.model)}...`
        : `Generating image with ${chalk.cyan(options.model)}...`,
      spinner: 'dots',
    }).start();

    try {
      const provider = getProviderForModel(options.model);
      const generatedPaths: string[] = [];

      for (let i = 1; i <= variationCount; i++) {
        const outputPath = isMultiple ? `${basePath}-v${i}${ext}` : baseOutput;

        if (isMultiple) {
          spinner.text = `Generating variation ${i}/${variationCount}...`;
        }

        // Generate the image
        const result = await provider.generate({ ...options, output: outputPath });

        if (!result.success) {
          spinner.fail(chalk.red(`Generation failed: ${result.error}`));
          process.exit(1);
        }

        // Post-processing: remove background
        if (options.removeBg && result.outputPath) {
          spinner.text = isMultiple
            ? `Removing background (${i}/${variationCount})...`
            : 'Removing background...';
          await removeBackground(result.outputPath, result.outputPath);
        }

        // Post-processing: add background color
        if (options.addBg && result.outputPath) {
          spinner.text = 'Adding background color...';
          await addBackgroundColor(result.outputPath, result.outputPath, options.addBg);
        }

        // Post-processing: generate thumbnail
        if (options.thumbnail && result.outputPath) {
          spinner.text = 'Generating thumbnail...';
          const size = typeof options.thumbnail === 'number' ? options.thumbnail : 256;
          await generateThumbnail(result.outputPath, { size });
        }

        generatedPaths.push(result.outputPath!);
      }

      spinner.succeed(chalk.green(
        isMultiple
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

      // Open the first image on macOS
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
  ${chalk.dim('# Generate with default (nano-banana-pro)')}
  $ generate -p "A serene mountain landscape at sunset"

  ${chalk.dim('# Generate with OpenAI in HD quality')}
  $ generate -m gpt-image-1 -p "Abstract digital art" -q hd

  ${chalk.dim('# Generate with transparent background')}
  $ generate -m gpt-image-1 -p "A cute robot mascot" --transparent

  ${chalk.dim('# Edit an existing image (gpt-image-1.5)')}
  $ generate -m gpt-image-1.5 -p "Add a hat to the person" -r ./photo.png

  ${chalk.dim('# Generate with specific aspect ratio')}
  $ generate -m imagen-4 -p "Cinematic scene" -a 21:9

  ${chalk.dim('# Generate with reference image')}
  $ generate -m flux -p "Same style as reference" -r ./reference.png

  ${chalk.dim('# Generate with multiple reference images (Gemini)')}
  $ generate -p "Blend these styles" -r style1.png -r style2.png

  ${chalk.dim('# Generate 5 variations')}
  $ generate -p "Abstract art" --variations 5 -o ~/Downloads/abstract.png

${chalk.bold('Environment Variables:')}
  GOOGLE_API_KEY         Required for Gemini/Imagen models
  OPENAI_API_KEY         Required for GPT-Image models
  REPLICATE_API_TOKEN    Required for Flux models
  REMOVE_BG_API_KEY      Required for --remove-bg feature
`);

program.parse();
