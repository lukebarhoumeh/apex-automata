import fs from 'node:fs';
import path from 'node:path';

export async function appendCsvRow(filePath: string, headers: string[], row: (string|number|null|undefined)[]) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
  const line = row.map(v => v == null ? '' : String(v)).join(',');
  if (!exists) {
    await fs.promises.writeFile(filePath, headers.join(',') + '\n' + line + '\n');
  } else {
    await fs.promises.appendFile(filePath, line + '\n');
  }
}
