import fs from 'fs';

/**
 * Write to stdout synchronously and completely. `process.stdout.write()` is
 * asynchronous on pipes, so a `process.exit()` right after it truncates piped
 * output at the pipe buffer (64 KB): `generate --voices --json | jq` broke that way.
 */
export function writeStdoutSync(text: string): void {
  const buf = Buffer.from(text);
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      throw err;
    }
  }
}
