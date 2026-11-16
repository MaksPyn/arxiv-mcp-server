/**
 * Configuration loading.
 *
 * MCP clients launch the server from an arbitrary working directory, so a
 * plain `dotenv.config()` (which only reads `./.env` from the cwd) silently
 * misses the project's .env file. This module looks for a .env file in a few
 * well-defined places, never overrides variables the client already set, and
 * resolves relative paths against the directory of the .env file that defined
 * them.
 *
 * Precedence (highest first):
 *   1. Variables set by the MCP client / shell (the "env" block in the client config)
 *   2. The file named by ARXIV_MCP_ENV_FILE
 *   3. ./.env in the current working directory
 *   4. .env in the package root (next to package.json)
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

export interface Config {
  serverName: string;
  version: string;
  storageDir: string;
  logLevel: LogLevel;
  logFile: string | undefined;
  rateLimitDelayMs: number;
  requestTimeoutMs: number;
  maxPdfSizeMb: number;
  maxStorageSizeMb: number;
  promptsFile: string | undefined;
  /** .env files that were actually read, for diagnostics. */
  envFilesLoaded: string[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

interface EnvValue {
  value: string;
  /** Directory that relative paths in this value are resolved against. */
  baseDir: string;
}

/** Candidate .env files in precedence order (highest first). */
export function envFileCandidates(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const candidates: string[] = [];
  if (env.ARXIV_MCP_ENV_FILE) candidates.push(path.resolve(cwd, expandHome(env.ARXIV_MCP_ENV_FILE)));
  candidates.push(path.join(cwd, '.env'));
  candidates.push(path.join(PACKAGE_ROOT, '.env'));
  // De-duplicate (cwd may be the package root).
  return [...new Set(candidates)];
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const values = new Map<string, EnvValue>();
  const envFilesLoaded: string[] = [];

  // Lowest precedence first, so later files overwrite earlier ones.
  for (const file of envFileCandidates(env, cwd).reverse()) {
    if (!existsSync(file)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      continue;
    }
    envFilesLoaded.unshift(file);
    for (const [key, value] of Object.entries(parsed)) {
      values.set(key, { value, baseDir: path.dirname(file) });
    }
  }

  // Real environment variables always win over .env files.
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') values.set(key, { value, baseDir: cwd });
  }

  const get = (...names: string[]): EnvValue | undefined => {
    for (const name of names) {
      const v = values.get(name);
      if (v && v.value.trim() !== '') return v;
    }
    return undefined;
  };
  const getPath = (...names: string[]): string | undefined => {
    const v = get(...names);
    if (!v) return undefined;
    return path.resolve(v.baseDir, expandHome(v.value.trim()));
  };
  const getNumber = (fallback: number, ...names: string[]): number => {
    const v = get(...names);
    if (!v) return fallback;
    const n = Number(v.value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const logLevelRaw = get('LOG_LEVEL')?.value.trim().toLowerCase();
  const logLevel = LOG_LEVELS.includes(logLevelRaw as LogLevel) ? (logLevelRaw as LogLevel) : 'info';

  return {
    serverName: pkg.name,
    version: pkg.version,
    // ARXIV_STORAGE_DIR is preferred; STORAGE_DIR is kept for backwards compatibility.
    storageDir:
      getPath('ARXIV_STORAGE_DIR', 'STORAGE_DIR') ?? path.join(os.homedir(), '.arxiv-mcp-server', 'papers'),
    logLevel,
    logFile: getPath('LOG_FILE'),
    rateLimitDelayMs: getNumber(3000, 'RATE_LIMIT_DELAY_MS'),
    requestTimeoutMs: getNumber(20000, 'REQUEST_TIMEOUT_MS'),
    maxPdfSizeMb: getNumber(50, 'MAX_PDF_SIZE_MB'),
    maxStorageSizeMb: getNumber(0, 'MAX_STORAGE_SIZE_MB'),
    promptsFile: getPath('PROMPTS_FILE'),
    envFilesLoaded,
  };
}

export const config: Config = loadConfig();
