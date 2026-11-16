/**
 * Minimal logger. IMPORTANT: stdout is the MCP transport, so nothing may ever
 * be written there. Logs go to stderr (which MCP clients capture into their
 * own log files) and optionally to LOG_FILE.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { config, type LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let fileOk = Boolean(config.logFile);
if (config.logFile) {
  try {
    mkdirSync(path.dirname(config.logFile), { recursive: true });
  } catch {
    fileOk = false;
  }
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      return inspect(a, { depth: 4, breakLength: Infinity });
    })
    .join(' ');
}

function write(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (ORDER[level] < ORDER[config.logLevel]) return;
  const line = `${new Date().toISOString()} [${level}] ${format(args)}\n`;
  process.stderr.write(line);
  if (fileOk && config.logFile) {
    try {
      appendFileSync(config.logFile, line);
    } catch {
      fileOk = false;
    }
  }
}

export const logger = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};
