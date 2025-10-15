import fs from 'node:fs';
import path from 'node:path';

export async function writeSnapshot(filePath: string, obj: unknown) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.promises.rename(tmp, filePath);
}
