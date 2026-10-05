/** Parse repeatable --param key=value. Values that parse as JSON keep their type. */
export function parseParams(list: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of list) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`--param expects key=value, got "${item}"`);
    const key = item.slice(0, eq).trim();
    const raw = item.slice(eq + 1);
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
