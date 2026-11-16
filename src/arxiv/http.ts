/**
 * Polite HTTP access to arXiv.
 *
 * arXiv asks API clients to make no more than one request every three seconds
 * and to use a single connection. All requests (API and PDF) go through one
 * serialized queue so concurrent tool calls cannot burst past that limit.
 */
import { config } from '../config.js';
import { UpstreamError } from '../errors.js';
import { logger } from '../logger.js';

const USER_AGENT = `${config.serverName}/${config.version}`;
const MAX_ATTEMPTS = 3;

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` after all previously scheduled requests, honouring the rate limit. */
function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = lastRequestAt + config.rateLimitDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export interface FetchOptions {
  accept?: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /**
   * Total time budget across all attempts, including waiting in the queue.
   * Kept below the 60 s request timeout most MCP clients use.
   */
  budgetMs?: number;
}

const DEFAULT_BUDGET_MS = 50_000;

/**
 * Fetch a URL through the rate-limited queue, retrying on 5xx and network
 * errors with exponential backoff, within an overall time budget. HTTP 429
 * fails immediately with an explanatory message. Returns the
 * Response for the caller to consume.
 */
export async function arxivFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  let lastError: unknown;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await schedule(async () => {
        const remaining = deadline - Date.now();
        if (remaining < 1000) throw Object.assign(new Error('time budget exhausted'), { name: 'TimeoutError' });
        logger.debug(`GET ${url} (attempt ${attempt})`);
        return fetch(url, {
          headers: { 'User-Agent': USER_AGENT, ...(opts.accept ? { Accept: opts.accept } : {}) },
          redirect: 'follow',
          signal: AbortSignal.timeout(Math.min(opts.timeoutMs ?? config.requestTimeoutMs, remaining)),
        });
      });
      if (res.ok) return res;

      await res.body?.cancel().catch(() => undefined);
      lastStatus = res.status;
      // arXiv asks clients to back off on 429; retrying within seconds only prolongs the block.
      if (res.status === 429) break;
      if (res.status < 500) {
        throw new UpstreamError(`arXiv responded with HTTP ${res.status} for ${url}`, res.status, false);
      }
      lastError = new UpstreamError(`arXiv responded with HTTP ${res.status}`, res.status, true);
      logger.warn(`arXiv returned HTTP ${res.status} for ${url} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * 2 ** (attempt - 1);
      if (attempt === MAX_ATTEMPTS || Date.now() + backoff > deadline - 2000) break;
      await sleep(backoff);
    } catch (err) {
      if (err instanceof UpstreamError && !err.retryable) throw err;
      // Network error or timeout: back off and retry if the budget allows.
      lastError = err;
      logger.warn(`Request to ${url} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${(err as Error)?.message}`);
      const backoff = 2000 * 2 ** (attempt - 1);
      if (attempt === MAX_ATTEMPTS || Date.now() + backoff > deadline - 2000) break;
      await sleep(backoff);
    }
  }

  if (lastStatus === 429) {
    throw new UpstreamError(
      'arXiv is rate-limiting requests from this IP address (HTTP 429). Wait a minute or two before trying again, ' +
        'and avoid many rapid searches. Papers that are already downloaded can still be read.',
      429,
      true,
    );
  }
  if (lastStatus !== undefined && lastStatus >= 500) {
    throw new UpstreamError(`arXiv is temporarily unavailable (HTTP ${lastStatus}). Try again shortly.`, lastStatus, true);
  }
  const msg = (lastError as Error)?.name === 'TimeoutError' ? 'timed out' : (lastError as Error)?.message;
  throw new UpstreamError(`Could not reach arXiv (${msg}). Check your network connection, or arXiv may be overloaded; try again shortly.`);
}
