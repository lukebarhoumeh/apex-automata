import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function timestamp() {
  return new Date().toISOString();
}

export interface Logger {
  debug: (msg: string, extra?: unknown) => void;
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
}

export function createLogger(logFilePath?: string): Logger {
  let stream: fs.WriteStream | null = null;
  if (logFilePath) {
    const dir = path.dirname(logFilePath);
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(logFilePath, { flags: 'a' });
  }

  const write = (level: LogLevel, msg: string, extra?: unknown) => {
    const line = { t: timestamp(), level, msg, extra };
    // Console pretty
    let prefix = '\u001b[90mDEBUG\u001b[0m';
    if (level === 'info') {
      prefix = '\u001b[32mINFO\u001b[0m';
    } else if (level === 'warn') {
      prefix = '\u001b[33mWARN\u001b[0m';
    } else if (level === 'error') {
      prefix = '\u001b[31mERROR\u001b[0m';
    }
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${line.t} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
    if (stream) {
      stream.write(JSON.stringify(line) + '\n');
    }
  };

  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
  };
}
