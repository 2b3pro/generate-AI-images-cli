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
        request: {
          prompt_sent: prompt,
          params: { reasoning_effort: spec.reasoning_effort ?? 'high', agent_model: spec.agent_model ?? 'codex default' },
          refs: refs.map((r) => ({ role: 'reference', path: r.path, note: r.label })),
          draft: false,
        },
      };
    } catch (err) {
      return { success: false, error: `Codex: ${(err as Error).message}` };
    } finally {
      if (stage) fs.rmSync(stage.stageDir, { recursive: true, force: true });
    }
  }
}
