/**
 * arXiv identifier handling.
 *
 * Supports:
 *   - new-style IDs:  2301.00001, 0704.0001, 2301.00001v2
 *   - old-style IDs:  hep-th/9901001, math.CO/0501001v1
 *   - "arXiv:" prefixes and abs/pdf/html URLs (arxiv.org, export.arxiv.org, alphaxiv, etc.)
 */
import { ValidationError } from '../errors.js';

const NEW_STYLE = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const OLD_STYLE = /^([a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;

export interface ParsedId {
  /** ID without version, e.g. "2301.00001" or "hep-th/9901001". */
  base: string;
  /** Version suffix such as "v2", or undefined for "latest". */
  version: string | undefined;
  /** base + version. */
  full: string;
}

export function parseArxivId(input: string): ParsedId {
  let s = String(input ?? '').trim();

  // Strip URLs down to the identifier part.
  const url = s.match(/arxiv\.org\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i);
  if (url) s = url[1]!;
  s = s.replace(/^arxiv:\s*/i, '');

  const m = s.match(NEW_STYLE) ?? s.match(OLD_STYLE);
  if (!m) {
    throw new ValidationError(
      `"${input}" is not a valid arXiv identifier. Expected something like 2301.00001, 2301.00001v2 or hep-th/9901001.`,
    );
  }
  const base = m[1]!;
  const version = m[2];
  return { base, version, full: version ? base + version : base };
}

/** Returns true when the string is a syntactically valid arXiv ID (or arXiv URL). */
export function isArxivId(input: string): boolean {
  try {
    parseArxivId(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the identifier from the <id> element of an Atom entry,
 * e.g. "http://arxiv.org/abs/hep-th/9901001v1" -> "hep-th/9901001v1".
 * (The previous implementation used split('/').pop(), which broke old-style IDs.)
 */
export function idFromEntryUrl(entryId: string): string {
  const m = entryId.match(/arxiv\.org\/abs\/(.+)$/);
  return m ? m[1]! : entryId;
}

/** Filesystem-safe representation of an ID (no slashes). */
export function idToFileStem(id: string): string {
  return parseArxivId(id).full.replace('/', '_');
}
