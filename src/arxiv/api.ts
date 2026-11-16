/**
 * arXiv Atom API client.
 */
import { XMLParser } from 'fast-xml-parser';
import { NotFoundError, UpstreamError, ValidationError } from '../errors.js';
import { arxivFetch } from './http.js';
import { idFromEntryUrl, parseArxivId } from './ids.js';
import { buildSearchQuery, type SearchParams } from './query.js';

const API_BASE = 'https://export.arxiv.org/api/query';
/** arXiv recommends at most 2000 results per call; we cap lower to keep responses manageable. */
export const MAX_RESULTS_PER_CALL = 200;

export interface Paper {
  id: string;
  /** ID without version. */
  baseId: string;
  title: string;
  authors: string[];
  affiliations?: Record<string, string>;
  summary: string;
  published: string;
  updated: string;
  primaryCategory: string;
  categories: string[];
  comment?: string;
  journalRef?: string;
  doi?: string;
  absUrl: string;
  pdfUrl: string;
}

export interface SearchResult {
  totalResults: number;
  start: number;
  papers: Paper[];
}

export type SortBy = 'relevance' | 'submittedDate' | 'lastUpdatedDate';
export type SortOrder = 'ascending' | 'descending';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  parseTagValue: false,
  isArray: (name) => ['entry', 'author', 'link', 'category', 'affiliation'].includes(name),
});

const clean = (s: unknown): string =>
  (typeof s === 'object' && s !== null ? String((s as Record<string, unknown>)['#text'] ?? '') : String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();

function parseEntry(e: any): Paper {
  const id = idFromEntryUrl(clean(e.id));
  const { base } = parseArxivId(id);
  const authors: string[] = [];
  const affiliations: Record<string, string> = {};
  for (const a of e.author ?? []) {
    const name = clean(a.name);
    if (!name) continue;
    authors.push(name);
    const aff = (a.affiliation ?? []).map(clean).filter(Boolean);
    if (aff.length) affiliations[name] = aff.join('; ');
  }
  const links: Array<Record<string, string>> = e.link ?? [];
  const pdf = links.find((l) => l['@_title'] === 'pdf' || l['@_type'] === 'application/pdf');
  const abs = links.find((l) => l['@_rel'] === 'alternate');
  const doi = links.find((l) => l['@_title'] === 'doi');

  return {
    id,
    baseId: base,
    title: clean(e.title),
    authors,
    ...(Object.keys(affiliations).length ? { affiliations } : {}),
    summary: clean(e.summary),
    published: clean(e.published),
    updated: clean(e.updated),
    primaryCategory: e.primary_category?.['@_term'] ?? '',
    categories: (e.category ?? []).map((c: Record<string, string>) => c['@_term']).filter(Boolean),
    comment: clean(e.comment) || undefined,
    journalRef: clean(e.journal_ref) || undefined,
    doi: clean(e.doi) || (doi ? doi['@_href']?.replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : undefined) || undefined,
    absUrl: (abs?.['@_href'] ?? `https://arxiv.org/abs/${id}`).replace(/^http:/, 'https:'),
    pdfUrl: (pdf?.['@_href'] ?? `https://arxiv.org/pdf/${id}`).replace(/^http:/, 'https:'),
  };
}

export function parseFeed(xml: string): SearchResult {
  const doc = parser.parse(xml);
  const feed = doc?.feed;
  if (!feed) throw new UpstreamError('Unexpected response from the arXiv API (no Atom feed).');

  const entries: unknown[] = feed.entry ?? [];
  // arXiv reports query errors as a single entry whose id points at /api/errors.
  const errorEntry = entries.find((e: any) => clean(e?.id).includes('/api/errors'));
  if (errorEntry) {
    throw new ValidationError(`arXiv rejected the query: ${clean((errorEntry as any).summary)}`);
  }

  return {
    totalResults: Number(clean(feed.totalResults)) || 0,
    start: Number(clean(feed.startIndex)) || 0,
    // Entries for unknown IDs come back without a title; drop them.
    papers: entries.filter((e: any) => clean(e?.title) && clean(e?.id)).map(parseEntry),
  };
}

// Small in-memory cache so repeated calls (e.g. get_papers then analyze_paper) do not hit arXiv again.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; value: SearchResult }>();

async function query(params: URLSearchParams): Promise<SearchResult> {
  const url = `${API_BASE}?${params}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const res = await arxivFetch(url, { accept: 'application/atom+xml' });
  const value = parseFeed(await res.text());
  cache.delete(url);
  cache.set(url, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return value;
}

export async function searchPapers(
  search: SearchParams,
  opts: { start?: number; maxResults?: number; sortBy?: SortBy; sortOrder?: SortOrder } = {},
): Promise<SearchResult & { query: string }> {
  const q = buildSearchQuery(search);
  const params = new URLSearchParams({
    search_query: q,
    start: String(Math.max(0, Math.floor(opts.start ?? 0))),
    max_results: String(Math.min(Math.max(1, Math.floor(opts.maxResults ?? 10)), MAX_RESULTS_PER_CALL)),
    sortBy: opts.sortBy ?? 'relevance',
    sortOrder: opts.sortOrder ?? 'descending',
  });
  return { ...(await query(params)), query: q };
}

/** Fetch metadata for specific IDs. IDs that do not exist are reported in `missing`. */
export async function getPapers(ids: string[]): Promise<{ papers: Paper[]; missing: string[] }> {
  if (ids.length === 0) throw new ValidationError('Provide at least one arXiv ID.');
  if (ids.length > MAX_RESULTS_PER_CALL) throw new ValidationError(`At most ${MAX_RESULTS_PER_CALL} IDs per call.`);
  const parsed = ids.map(parseArxivId);
  const params = new URLSearchParams({
    id_list: parsed.map((p) => p.full).join(','),
    max_results: String(parsed.length),
  });
  const { papers } = await query(params);
  const found = new Set(papers.flatMap((p) => [p.id, p.baseId]));
  const missing = parsed.filter((p) => !found.has(p.full) && !found.has(p.base)).map((p) => p.full);
  return { papers, missing };
}

export async function getPaper(id: string): Promise<Paper> {
  const { papers } = await getPapers([id]);
  const paper = papers[0];
  if (!paper) throw new NotFoundError(`No arXiv paper found with ID ${parseArxivId(id).full}.`);
  return paper;
}
