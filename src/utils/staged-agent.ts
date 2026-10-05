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

/**
 * Per-call API keys removed from an agent's environment. Agent providers are
 * plan-billed; with these present, an agent (or a tool it calls) could bill a
 * metered key instead, silently breaking the --billing plan guarantee.
 */
export const METERED_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_PROJECT_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'NANOBANANA_API_KEY',
  'ATLASCLOUD_API_KEY',
  'REPLICATE_API_TOKEN',
  'REPLICATE_API_KEY',
  'REMOVE_BG_API_KEY',
  'ANTHROPIC_API_KEY',
];

export function agentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && !METERED_KEYS.includes(k)) env[k] = v;
  return env;
}

export async function runAgent(cmd: string, args: string[], o: { cwd: string; stdin?: string; timeoutMs: number }): Promise<{ code: number; timedOut: boolean; stderrTail: string }> {
  // Own process group (detached) so a timeout can kill the agent and every
  // child it started; a bare SIGTERM to the agent can be deferred while a child
  // runs, and orphaned children keep stderr open. The live environment is passed
  // explicitly because Bun.spawn's default does not reflect process.env changes
  // made after startup, minus metered API keys (see METERED_KEYS).
  const proc = Bun.spawn([cmd, ...args], {
    cwd: o.cwd,
    env: agentEnv(),
    detached: true,
    stdin: o.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (o.stdin !== undefined && proc.stdin) {
    proc.stdin.write(o.stdin);
    proc.stdin.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      proc.kill('SIGKILL');
    }
  }, o.timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  const stderr = timedOut ? '' : await new Response(proc.stderr).text();
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
