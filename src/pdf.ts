/**
 * PDF text extraction (via unpdf / PDF.js) and light-weight section detection.
 */
import { readFile } from 'node:fs/promises';
import { getDocumentProxy } from 'unpdf';
import { UserFacingError } from './errors.js';
import { logger } from './logger.js';

export interface Section {
  title: string;
  /** Character offset of the heading in the full text. */
  start: number;
  end: number;
}

/** Extract text, preserving line breaks, with a form-feed (\f) between pages. */
export async function extractPdfText(file: string): Promise<string> {
  const data = new Uint8Array(await readFile(file));
  let doc;
  try {
    doc = await getDocumentProxy(data, { verbosity: 0 } as never);
  } catch (err) {
    logger.error(`Failed to open PDF ${file}:`, err);
    throw new UserFacingError('Could not parse the PDF. It may be corrupted; try download_paper with force=true.');
  }
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let out = '';
      let lastY: number | undefined;
      let lastHeight = 0;
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean; transform?: number[]; height?: number }>) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform?.[5];
        const h = Math.max(item.height ?? 0, lastHeight);
        // Super/subscripts shift the baseline by less than a line height; do not break lines for them.
        if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > Math.max(2, h * 0.75) && !out.endsWith('\n')) {
          out += '\n';
        }
        out += item.str;
        if (item.hasEOL && !out.endsWith('\n\n')) out += '\n';
        if (y !== undefined && item.str.trim()) {
          lastY = y;
          lastHeight = item.height ?? 0;
        }
      }
      pages.push(normalize(out));
      page.cleanup();
    }
    return pages.join('\n\f\n');
  } finally {
    // Frees the PDF.js worker resources (loadingTask is missing from the bundled typings).
    await (doc as unknown as { loadingTask?: { destroy(): Promise<void> } }).loadingTask?.destroy();
  }
}

function normalize(text: string): string {
  return (
    text
      .replace(/­\n?/g, '') // soft hyphens
      .replace(/(\w)-\n(\w)/g, '$1$2') // words hyphenated across lines
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

const KNOWN_HEADINGS =
  /^(abstract|introduction|background|related work|preliminaries|methods|methodology|experiments|experimental (?:setup|results)|results(?: and discussion)?|discussion|limitations|future work|conclusions?(?: and future work)?|acknowledge?ments?|references|bibliography|appendix|appendices|supplementary material)$/i;

/**
 * Detect section headings such as "1 Introduction", "2.3 Training details",
 * "III. METHODS", "Abstract", "References". Heuristic, but good enough to let
 * the model jump to a section instead of paging through the whole paper.
 */
export function detectSections(text: string): Section[] {
  const headings: Array<{ title: string; start: number }> = [];
  const lineRe = /^.*$/gm;
  let m: RegExpExecArray | null;
  let seenReferences = false;
  while ((m = lineRe.exec(text)) !== null) {
    if (m[0].length === 0) {
      lineRe.lastIndex++;
      continue;
    }
    const line = m[0].trim();
    if (line.length < 4 || line.length > 80) continue;

    const numbered = line.match(/^((?:\d{1,2}(?:\.\d{1,2}){0,2}|[IVX]{1,5}|[A-H])\.?)\s+([A-Z][^.!?]{2,70})$/);
    const headingText = numbered?.[2] ?? '';
    const isNumbered =
      numbered &&
      !/\d{3,}/.test(line) && // not a table row or a citation
      headingText.split(/\s+/).length <= 10 &&
      /[A-Za-z]{3,}/.test(headingText) && // has at least one real word
      !/[=<>^∑∫]/.test(headingText) && // not a formula
      !/\s\d+$/.test(headingText) && // not a table-of-contents entry ending in a page number
      !/[,;:=]$/.test(line);
    // Only accept letter-numbered headings (A, B, ...) after the references, where appendices live.
    const letterOnly = numbered && /^[A-H]\.?$/.test(numbered[1]!);
    // Named headings must be capitalised ("Conclusion", "REFERENCES"), which rules out stray words from tables and formulas.
    const known = /^[A-Z]/.test(line) && KNOWN_HEADINGS.test(line.replace(/[:.]$/, ''));

    if ((isNumbered && (!letterOnly || seenReferences)) || known) {
      const prev = headings.at(-1);
      // Ignore repeated running headers.
      if (prev && prev.title === line) continue;
      headings.push({ title: line, start: m.index });
      if (/^(references|bibliography)$/i.test(line)) seenReferences = true;
    }
  }
  return headings.map((h, i) => ({ ...h, end: headings[i + 1]?.start ?? text.length }));
}

/** Find a section by (case-insensitive) title, number ("3", "3.2") or keyword ("method"). */
export function findSection(sections: Section[], query: string): Section | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const bare = (t: string) => t.toLowerCase().replace(/^((?:\d{1,2}(?:\.\d{1,2}){0,2}|[ivx]{1,5}|[a-h])\.?)\s+/, '');
  const num = (t: string) => t.toLowerCase().match(/^((?:\d{1,2}(?:\.\d{1,2}){0,2}|[ivx]{1,5}|[a-h]))\.?\s/)?.[1];
  return (
    sections.find((s) => s.title.toLowerCase() === q) ??
    sections.find((s) => bare(s.title) === q) ??
    sections.find((s) => num(s.title) === q.replace(/\.$/, '')) ??
    sections.find((s) => bare(s.title).startsWith(q)) ??
    sections.find((s) => s.title.toLowerCase().includes(q))
  );
}

export interface TextMatch {
  offset: number;
  section?: string;
  context: string;
}

/** Literal (non-regex) search with surrounding context. */
export function searchText(
  text: string,
  term: string,
  opts: { caseSensitive?: boolean; contextChars?: number; maxMatches?: number; sections?: Section[] } = {},
): { total: number; matches: TextMatch[] } {
  const needle = opts.caseSensitive ? term : term.toLowerCase();
  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const ctx = opts.contextChars ?? 150;
  const max = opts.maxMatches ?? 30;
  const matches: TextMatch[] = [];
  let total = 0;
  if (!needle) return { total, matches };
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    total++;
    if (matches.length >= max) continue;
    const start = Math.max(0, i - ctx);
    const end = Math.min(text.length, i + needle.length + ctx);
    const section = opts.sections?.filter((s) => s.start <= i).at(-1)?.title;
    matches.push({
      offset: i,
      ...(section ? { section } : {}),
      context: (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : ''),
    });
  }
  return { total, matches };
}
