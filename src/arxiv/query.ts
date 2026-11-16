/**
 * Builds arXiv API `search_query` strings.
 * Syntax reference: https://info.arxiv.org/help/api/user-manual.html#query_details
 */
import { ValidationError } from '../errors.js';
import { canonicalCategory, isKnownCategoryOrArchive, suggestCategories } from './categories.js';

export interface SearchParams {
  /** Advanced query in raw arXiv syntax, e.g. `ti:transformer AND cat:cs.CL`. */
  query?: string;
  title?: string;
  author?: string;
  abstract?: string;
  /** Free text searched across all fields. */
  all?: string;
  /** One or more categories (OR-ed together), e.g. ["cs.AI", "cs.LG"]. */
  categories?: string[];
  /** Inclusive submission-date range, YYYY-MM-DD (or YYYY, YYYY-MM). */
  submittedFrom?: string;
  submittedTo?: string;
}

/**
 * Common words arXiv's search index does not store. Requiring one of them
 * (e.g. `ti:is`) makes an AND query match nothing, so they are dropped from
 * unquoted terms. Dropping an indexed word only broadens the search slightly.
 */
const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can do does for from has have how if in into is it its no not of on or our ' +
    'such that the their then there these they this to was we what when which why will with all you your'
  ).split(' '),
);

/** Split text into search terms, keeping "quoted phrases" together and dropping syntax characters and stopwords. */
export function tokenize(text: string): string[] {
  const all = splitTerms(text);
  const meaningful = all.filter((t) => t.startsWith('"') || !STOPWORDS.has(t.toLowerCase()));
  // If the user typed only stopwords, keep them rather than produce an empty query.
  return meaningful.length ? meaningful : all;
}

function splitTerms(text: string): string[] {
  const terms: string[] = [];
  for (const m of text.matchAll(/"([^"]+)"|(\S+)/g)) {
    const raw = (m[1] ?? m[2] ?? '').replace(/[()"\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    // Bare boolean operators would change the query's meaning.
    if (!m[1] && /^(AND|OR|ANDNOT|TO)$/.test(raw)) continue;
    terms.push(raw.includes(' ') ? `"${raw}"` : raw);
  }
  return terms;
}

function fieldClause(prefix: string, text: string | undefined, asPhrase = false): string | undefined {
  if (!text?.trim()) return undefined;
  if (asPhrase) {
    const clean = text.replace(/[()"\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return undefined;
    return clean.includes(' ') ? `${prefix}:"${clean}"` : `${prefix}:${clean}`;
  }
  const terms = tokenize(text);
  if (terms.length === 0) return undefined;
  const parts = terms.map((t) => `${prefix}:${t}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
}

/** Normalise a date string into arXiv's YYYYMMDDHHMM form. */
export function toArxivDate(input: string, endOfRange: boolean): string {
  const m = input.trim().match(/^(\d{4})(?:-?(\d{2}))?(?:-?(\d{2}))?$/);
  if (!m) throw new ValidationError(`Invalid date "${input}". Use YYYY-MM-DD, YYYY-MM or YYYY.`);
  const year = m[1]!;
  const month = m[2] ?? (endOfRange ? '12' : '01');
  let day = m[3];
  if (!day) {
    day = endOfRange ? String(new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()).padStart(2, '0') : '01';
  }
  const mm = Number(month);
  const dd = Number(day);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) throw new ValidationError(`Invalid date "${input}".`);
  return `${year}${month}${day}${endOfRange ? '2359' : '0000'}`;
}

export function validateCategories(categories: string[] | undefined): string[] {
  if (!categories?.length) return [];
  return categories.map((raw) => {
    const code = raw.trim();
    if (!isKnownCategoryOrArchive(code)) {
      const suggestions = suggestCategories(code);
      throw new ValidationError(
        `Unknown arXiv category "${raw}".` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '') +
          ' Use the list_categories tool to see all valid codes.',
      );
    }
    return canonicalCategory(code);
  });
}

export function buildSearchQuery(params: SearchParams): string {
  const clauses: string[] = [];

  if (params.query?.trim()) clauses.push(`(${params.query.trim()})`);
  const fields = [
    fieldClause('ti', params.title),
    fieldClause('au', params.author, true),
    fieldClause('abs', params.abstract),
    fieldClause('all', params.all),
  ];
  for (const f of fields) if (f) clauses.push(f);

  const cats = validateCategories(params.categories);
  if (cats.length === 1) clauses.push(`cat:${cats[0]}`);
  else if (cats.length > 1) clauses.push(`(${cats.map((c) => `cat:${c}`).join(' OR ')})`);

  if (params.submittedFrom || params.submittedTo) {
    const from = params.submittedFrom ? toArxivDate(params.submittedFrom, false) : '199101010000';
    const to = params.submittedTo ? toArxivDate(params.submittedTo, true) : '299912312359';
    if (from > to) throw new ValidationError('submittedFrom must be on or before submittedTo.');
    clauses.push(`submittedDate:[${from} TO ${to}]`);
  }

  if (clauses.length === 0) {
    throw new ValidationError(
      'Provide at least one search criterion: query, title, author, abstract, all, categories or a date range.',
    );
  }
  // A date range alone matches everything ever submitted in that window, which is fine.
  return clauses.join(' AND ');
}
