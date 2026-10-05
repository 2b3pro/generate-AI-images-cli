import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadModelRegistry } from '../../src/config/models';

/** Write provider YAML files (and optional routing.yaml) to a temp dir and load them. */
export function writeRegistry(files: Record<string, string>, routing?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-reg-'));
  const models = path.join(root, 'models');
  fs.mkdirSync(models);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(models, name), text);
  if (routing !== undefined) fs.writeFileSync(path.join(root, 'routing.yaml'), routing);
  process.env.GENERATE_MODELS_DIR = models;
  delete process.env.GENERATE_ROUTING_FILE;
  loadModelRegistry(true);
  return root;
}

export function useRealRegistry(): void {
  delete process.env.GENERATE_MODELS_DIR;
  delete process.env.GENERATE_ROUTING_FILE;
  loadModelRegistry(true);
}

export function tmpDir(prefix = 'gen-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
