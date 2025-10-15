import fs from 'node:fs';
import path from 'node:path';

export async function rotateIfTooLarge(filePath: string, maxBytes = 5 * 1024 * 1024, keep = 5) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size < maxBytes) return;
  } catch {
    return;
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rotated = path.join(dir, `${base}.${ts}.1`);
  await fs.promises.rename(filePath, rotated);

  // Cleanup old
  const entries = (await fs.promises.readdir(dir))
    .filter((f) => f.startsWith(base + '.'))
    .sort()
    .reverse();
  const stale = entries.slice(keep);
  await Promise.all(stale.map((f) => fs.promises.rm(path.join(dir, f), { force: true })));
}
