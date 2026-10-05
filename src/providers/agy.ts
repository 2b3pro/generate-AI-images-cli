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
        request: {
          prompt_sent: prompt,
          params: { effort: spec.reasoning_effort ?? 'high' },
          refs: refs.map((r) => ({ role: 'reference', path: r.path, note: r.label })),
          draft: false,
        },
      };
    } catch (err) {
      return { success: false, error: `agy: ${(err as Error).message}` };
    } finally {
      if (stage) fs.rmSync(stage.stageDir, { recursive: true, force: true });
    }
  }
}
