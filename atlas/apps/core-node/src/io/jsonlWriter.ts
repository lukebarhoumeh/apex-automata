import fs from 'node:fs';
import path from 'node:path';
import { rotateIfTooLarge } from './logRotate';

export class JSONLWriter {
  constructor(private filePath: string, private maxBytes = 5 * 1024 * 1024) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
  }

  async append(obj: unknown) {
    await rotateIfTooLarge(this.filePath, this.maxBytes);
    await fs.promises.appendFile(this.filePath, JSON.stringify(obj) + '\n');
  }
}
