import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getPaper, getPapers, MAX_RESULTS_PER_CALL, searchPapers, type Paper } from './arxiv/api.js';
import { CATEGORY_GROUPS, findCategories, TAXONOMY_RETRIEVED, TAXONOMY_SOURCE } from './arxiv/categories.js';
import { parseArxivId } from './arxiv/ids.js';
import { validateCategories } from './arxiv/query.js';
import { config } from './config.js';
import { UserFacingError, ValidationError } from './errors.js';
import { logger } from './logger.js';
import { findSection, searchText } from './pdf.js';
import { loadPrompts, renderPrompt } from './prompts.js';
import { forget, getPaperText } from './reader.js';
import { storage } from './storage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });

/** Wrap a handler so expected errors become readable tool errors instead of protocol errors. */
function handle<A>(name: string, fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (!(err instanceof UserFacingError)) logger.error(`Tool ${name} failed:`, err);
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  };
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MB`;

function authorsShort(authors: string[], max = 6): string {
  if (authors.length <= max) return authors.join(', ');
  return `${authors.slice(0, max).join(', ')} (+${authors.length - max} more)`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`;
}

function formatPaperBrief(p: Paper, i: number, fullAbstract: boolean): string {
  const cats = p.categories.filter((c) => c !== p.primaryCategory);
  return [
    `${i}. [${p.id}] ${p.title}`,
    `   Authors: ${authorsShort(p.authors)}`,
    `   Published: ${p.published.slice(0, 10)}${p.updated.slice(0, 10) !== p.published.slice(0, 10) ? ` (updated ${p.updated.slice(0, 10)})` : ''} · ${p.primaryCategory}${cats.length ? ` (also ${cats.join(', ')})` : ''}`,
    `   Abstract: ${fullAbstract ? p.summary : truncate(p.summary, 300)}`,
  ].join('\n');
}

function formatPaperFull(p: Paper): string {
  const lines = [
    `# ${p.title}`,
    `arXiv: ${p.id}`,
    `Authors: ${p.authors.map((a) => (p.affiliations?.[a] ? `${a} (${p.affiliations[a]})` : a)).join(', ')}`,
    `Published: ${p.published.slice(0, 10)} · Updated: ${p.updated.slice(0, 10)}`,
    `Primary category: ${p.primaryCategory} · All: ${p.categories.join(', ')}`,
  ];
  if (p.comment) lines.push(`Comment: ${p.comment}`);
  if (p.journalRef) lines.push(`Journal ref: ${p.journalRef}`);
  if (p.doi) lines.push(`DOI: ${p.doi}`);
  lines.push(`Abstract page: ${p.absUrl}`, `PDF: ${p.pdfUrl}`, '', p.summary);
  return lines.join('\n');
}

/** Accept ["cs.AI","cs.LG"], "cs.AI", or "cs.AI, cs.LG". */
const categoriesArg = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(/[\s,]+/)).filter(Boolean)));

const idsArg = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(/[\s,]+/)).filter(Boolean));

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer(
    { name: config.serverName, version: config.version },
    {
      instructions:
        'Tools for arXiv. Typical workflow: search_papers (or get_recent_papers) to find papers → get_papers for full metadata → ' +
        'read_paper to read the full text (it downloads the PDF automatically) → search_in_paper to find specific passages. ' +
        'Use list_categories to find valid category codes such as cs.AI or math.CO.',
    },
  );

  // --- Discovery ----------------------------------------------------------

  server.registerTool(
    'search_papers',
    {
      title: 'Search arXiv',
      description:
        'Search arXiv papers. Combine any of: free text (all), title, author, abstract, categories and a submission-date range; ' +
        'all given criteria must match. Multi-word title/abstract/all searches match papers containing every word; wrap words in double quotes for an exact phrase. ' +
        'For advanced use, `query` accepts raw arXiv syntax (prefixes ti: au: abs: co: jr: cat: all:, operators AND OR ANDNOT).',
      inputSchema: {
        all: z.string().optional().describe('Free-text search across all fields'),
        title: z.string().optional().describe('Words that must appear in the title'),
        author: z.string().optional().describe('Author name, e.g. "Yoshua Bengio" or "Bengio"'),
        abstract: z.string().optional().describe('Words that must appear in the abstract'),
        categories: categoriesArg.describe('Category code(s), e.g. "cs.CL" or ["cs.AI","cs.LG"] (matched with OR). See list_categories.'),
        submittedFrom: z.string().optional().describe('Earliest submission date, YYYY-MM-DD (or YYYY-MM / YYYY)'),
        submittedTo: z.string().optional().describe('Latest submission date, YYYY-MM-DD (or YYYY-MM / YYYY)'),
        query: z.string().optional().describe('Raw arXiv query, e.g. `ti:"diffusion model" ANDNOT cat:cs.CV`. Combined with the other fields using AND.'),
        sortBy: z.enum(['relevance', 'submittedDate', 'lastUpdatedDate']).default('relevance'),
        sortOrder: z.enum(['descending', 'ascending']).default('descending'),
        start: z.number().int().min(0).default(0).describe('Offset for paging through results'),
        maxResults: z.number().int().min(1).max(MAX_RESULTS_PER_CALL).default(10),
        fullAbstracts: z.boolean().default(false).describe('Return complete abstracts instead of a 300-character preview'),
      },
      annotations: READ_ONLY,
    },
    handle('search_papers', async (a) => {
      const r = await searchPapers(
        {
          all: a.all,
          title: a.title,
          author: a.author,
          abstract: a.abstract,
          categories: a.categories,
          submittedFrom: a.submittedFrom,
          submittedTo: a.submittedTo,
          query: a.query,
        },
        { start: a.start, maxResults: a.maxResults, sortBy: a.sortBy, sortOrder: a.sortOrder },
      );
      if (r.papers.length === 0) {
        return text(`No papers found (arXiv query: ${r.query}).${r.totalResults > 0 ? ` There are ${r.totalResults} results in total; try a smaller start offset.` : ''}`);
      }
      const end = r.start + r.papers.length;
      const header = `Found ${r.totalResults} papers, showing ${r.start + 1}–${end} (arXiv query: ${r.query}).`;
      const more = end < r.totalResults ? `\n\nMore results available: call again with start=${end}.` : '';
      return text(`${header}\n\n${r.papers.map((p, i) => formatPaperBrief(p, r.start + i + 1, a.fullAbstracts)).join('\n\n')}${more}`);
    }),
  );

  server.registerTool(
    'get_papers',
    {
      title: 'Get papers by arXiv ID',
      description:
        'Get full metadata (all authors, affiliations, complete abstract, comments, journal reference, DOI, links) for one or more papers. ' +
        'Accepts IDs like 2301.00001, 2301.00001v2, hep-th/9901001, or arxiv.org URLs.',
      inputSchema: {
        ids: idsArg.describe('One or more arXiv IDs or URLs'),
      },
      annotations: READ_ONLY,
    },
    handle('get_papers', async ({ ids }) => {
      const { papers, missing } = await getPapers(ids);
      const parts = papers.map(formatPaperFull);
      if (missing.length) parts.push(`Not found on arXiv: ${missing.join(', ')}`);
      return text(parts.join('\n\n---\n\n'));
    }),
  );

  server.registerTool(
    'get_recent_papers',
    {
      title: 'Latest papers in a category',
      description: 'List the most recently submitted papers in one or more arXiv categories (e.g. cs.AI, astro-ph.CO, or a whole archive like math).',
      inputSchema: {
        categories: categoriesArg.describe('Category code(s), e.g. "cs.LG" or ["cs.CL","cs.AI"]'),
        maxResults: z.number().int().min(1).max(MAX_RESULTS_PER_CALL).default(10),
        fullAbstracts: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    handle('get_recent_papers', async (a) => {
      if (!a.categories?.length) throw new ValidationError('Provide at least one category, e.g. "cs.AI". Use list_categories to browse codes.');
      const r = await searchPapers({ categories: a.categories }, { maxResults: a.maxResults, sortBy: 'submittedDate', sortOrder: 'descending' });
      const header = `${r.papers.length} most recent submissions in ${validateCategories(a.categories).join(', ')} (${r.totalResults} papers in total):`;
      return text(`${header}\n\n${r.papers.map((p, i) => formatPaperBrief(p, i + 1, a.fullAbstracts)).join('\n\n')}`);
    }),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'arXiv category taxonomy',
      description:
        'List official arXiv subject categories (e.g. cs.AI, math.CO, q-bio.NC) with their names and descriptions. ' +
        'Filter by group (cs, econ, eess, math, physics, q-bio, q-fin, stat, or a physics archive such as astro-ph / cond-mat) and/or search text. ' +
        'Use the codes with search_papers and get_recent_papers.',
      inputSchema: {
        group: z.string().optional().describe('Group or archive to list, e.g. "cs", "math", "physics", "astro-ph"'),
        search: z.string().optional().describe('Words to look for in the code, name or description, e.g. "neural", "number theory"'),
        includeDescriptions: z
          .boolean()
          .optional()
          .describe('Include each category\'s scope description. Defaults to true when 25 or fewer categories match.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle('list_categories', async (a) => {
      if (a.group && !CATEGORY_GROUPS.some((g) => g.id === a.group!.toLowerCase()) && findCategories({ group: a.group }).length === 0) {
        throw new ValidationError(
          `Unknown group "${a.group}". Groups: ${CATEGORY_GROUPS.map((g) => `${g.id} (${g.name})`).join(', ')}. Physics archives: astro-ph, cond-mat, gr-qc, hep-ex, hep-lat, hep-ph, hep-th, math-ph, nlin, nucl-ex, nucl-th, physics, quant-ph.`,
        );
      }
      const list = findCategories({ group: a.group, search: a.search });
      if (list.length === 0) return text(`No categories match${a.search ? ` "${a.search}"` : ''}${a.group ? ` in ${a.group}` : ''}.`);
      const describe = a.includeDescriptions ?? list.length <= 25;
      const lines: string[] = [`${list.length} arXiv categor${list.length === 1 ? 'y' : 'ies'} (source: ${TAXONOMY_SOURCE}, retrieved ${TAXONOMY_RETRIEVED}):`];
      let group = '';
      let archive: string | undefined = '';
      for (const c of list) {
        if (c.group !== group) {
          group = c.group;
          archive = '';
          lines.push('', `## ${c.groupName} (${c.group})`);
        }
        if (c.archive !== archive) {
          archive = c.archive;
          if (c.archive) lines.push(`### ${c.archiveName} (${c.archive})`);
        }
        lines.push(describe ? `- ${c.code} — ${c.name}: ${c.description}` : `- ${c.code} — ${c.name}`);
      }
      return text(lines.join('\n'));
    }),
  );

  // --- Local library & full text -----------------------------------------

  server.registerTool(
    'download_paper',
    {
      title: 'Download paper PDF',
      description: `Download a paper's PDF into local storage (${config.storageDir}). Not required before read_paper, which downloads automatically.`,
      inputSchema: {
        arxivId: z.string().describe('arXiv ID or URL'),
        force: z.boolean().default(false).describe('Re-download even if a copy is already stored'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handle('download_paper', async ({ arxivId, force }) => {
      const { paper, cached } = await storage.download(arxivId, { force });
      forget(paper.id);
      return text(
        `${cached ? 'Already downloaded' : 'Downloaded'}: [${paper.id}${paper.version}] ${paper.title}\n` +
          `File: ${storage.pdfPath(paper)} (${mb(paper.sizeBytes)})`,
      );
    }),
  );

  server.registerTool(
    'list_downloaded_papers',
    {
      title: 'List downloaded papers',
      description: 'List papers stored locally, with storage usage and the storage directory in use.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handle('list_downloaded_papers', async () => {
      const papers = await storage.list();
      const total = papers.reduce((n, p) => n + p.sizeBytes, 0);
      const limit = config.maxStorageSizeMb > 0 ? ` of ${config.maxStorageSizeMb} MB limit` : '';
      const lines = [
        `Storage directory: ${storage.dir}`,
        `${papers.length} paper${papers.length === 1 ? '' : 's'}, ${mb(total)}${limit}`,
      ];
      if (papers.length) lines.push('');
      for (const p of papers) {
        lines.push(`- [${p.id}${p.version}] ${p.title} — ${authorsShort(p.authors, 3)} · ${p.primaryCategory} · ${mb(p.sizeBytes)} · downloaded ${p.downloadedAt.slice(0, 10)}`);
      }
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'delete_paper',
    {
      title: 'Delete downloaded paper',
      description: 'Delete a paper (PDF and cached text) from local storage.',
      inputSchema: { arxivId: z.string().describe('arXiv ID of the stored paper') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handle('delete_paper', async ({ arxivId }) => {
      const id = parseArxivId(arxivId).base;
      const deleted = await storage.delete(id);
      forget(id);
      return text(deleted ? `Deleted ${id} from local storage.` : `${id} is not in local storage.`);
    }),
  );

  server.registerTool(
    'read_paper',
    {
      title: 'Read paper full text',
      description:
        'Read the full text of a paper, extracted from its PDF (downloaded automatically if needed). ' +
        'Long papers are returned in chunks: use `offset` to continue, or `section` to jump to a section such as "Introduction", "3", "3.2" or "conclusion". ' +
        'The first call lists the detected sections.',
      inputSchema: {
        arxivId: z.string().describe('arXiv ID or URL'),
        section: z.string().optional().describe('Section title or number to read, e.g. "Method", "4.1", "References"'),
        offset: z.number().int().min(0).default(0).describe('Character offset to start reading from'),
        maxChars: z.number().int().min(1000).max(100_000).default(20_000).describe('Maximum characters to return'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handle('read_paper', async (a) => {
      const { paper, text: full, sections, downloaded } = await getPaperText(a.arxivId);
      let start = a.offset;
      let stop = full.length;
      let label = '';
      if (a.section) {
        const s = findSection(sections, a.section);
        if (!s) {
          throw new ValidationError(
            `Section "${a.section}" not found. Detected sections: ${sections.map((x) => x.title).join(' | ') || '(none detected — read by offset instead)'}`,
          );
        }
        start = s.start + a.offset;
        stop = s.end;
        label = ` · section "${s.title}"`;
      }
      if (start >= stop) {
        throw new ValidationError(
          a.section
            ? `offset ${a.offset} is past the end of that section (${stop - (start - a.offset)} characters).`
            : `offset ${a.offset} is past the end of the text (${full.length} characters).`,
        );
      }

      let end = Math.min(stop, start + a.maxChars);
      // Avoid cutting mid-paragraph when possible.
      if (end < stop) {
        const para = full.lastIndexOf('\n\n', end);
        if (para > start + a.maxChars * 0.6) end = para;
      }
      const chunk = full.slice(start, end).replace(/\f/g, '\n[page break]\n');

      const header = [`# ${paper.title} [${paper.id}${paper.version}]${label}`, `Characters ${start}–${end} of ${full.length}${downloaded ? ' · PDF downloaded just now' : ''}`];
      if (start === 0 && !a.section && sections.length) {
        header.push(`Sections: ${sections.map((s) => s.title).join(' | ')}`);
      }
      const footer =
        end < stop
          ? `\n\n[… continues — call read_paper with ${a.section ? `section="${a.section}" and offset=${end - (start - a.offset)}` : `offset=${end}`}]`
          : a.section
            ? '\n\n[end of section]'
            : '\n\n[end of paper]';
      return text(`${header.join('\n')}\n\n${chunk}${footer}`);
    }),
  );

  server.registerTool(
    'search_in_paper',
    {
      title: 'Search within a paper',
      description: 'Find every occurrence of a word or phrase in a paper\'s full text (downloaded automatically if needed), with surrounding context and the section it appears in. Plain-text match, not regex.',
      inputSchema: {
        arxivId: z.string().describe('arXiv ID or URL'),
        query: z.string().min(1).describe('Word or phrase to find'),
        caseSensitive: z.boolean().default(false),
        maxMatches: z.number().int().min(1).max(200).default(30),
        contextChars: z.number().int().min(20).max(1000).default(150).describe('Characters of context on each side'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handle('search_in_paper', async (a) => {
      const { paper, text: full, sections } = await getPaperText(a.arxivId);
      const r = searchText(full, a.query, { caseSensitive: a.caseSensitive, maxMatches: a.maxMatches, contextChars: a.contextChars, sections });
      if (r.total === 0) return text(`"${a.query}" does not occur in ${paper.id} (${paper.title}).`);
      const lines = [`${r.total} match${r.total === 1 ? '' : 'es'} for "${a.query}" in [${paper.id}] ${paper.title}${r.total > r.matches.length ? ` (showing first ${r.matches.length})` : ''}:`, ''];
      for (const m of r.matches) lines.push(`- offset ${m.offset}${m.section ? ` · ${m.section}` : ''}: ${m.context}`);
      lines.push('', 'Use read_paper with an offset slightly before a match to read the surrounding text.');
      return text(lines.join('\n'));
    }),
  );

  // --- Analysis prompts ---------------------------------------------------

  const prompts = loadPrompts();
  const promptIds = prompts.map((p) => p.id);

  for (const p of prompts) {
    server.registerPrompt(
      p.id,
      {
        title: p.name,
        description: p.description,
        argsSchema: { arxivId: z.string().describe('arXiv ID of the paper to analyse') },
      },
      async ({ arxivId }) => {
        const paper = await getPaper(arxivId);
        return { messages: [{ role: 'user', content: { type: 'text', text: renderPrompt(p, paper) } }] };
      },
    );
  }

  server.registerTool(
    'analyze_paper',
    {
      title: 'Research analysis prompt',
      description:
        'Get a structured research-analysis brief for a paper (summary, key findings, methodology critique, literature-review entry, research gaps, etc.) filled with the paper\'s metadata. ' +
        'Omit promptId to list the available analyses. The same templates are also exposed as MCP prompts.',
      inputSchema: {
        arxivId: z.string().optional().describe('arXiv ID of the paper (required unless just listing analyses)'),
        promptId: z.string().optional().describe(`Analysis to run: ${promptIds.join(', ')}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handle('analyze_paper', async ({ arxivId, promptId }) => {
      if (!promptId) {
        return text(`Available analyses:\n${prompts.map((p) => `- ${p.id} — ${p.name}: ${p.description}`).join('\n')}`);
      }
      const p = prompts.find((x) => x.id === promptId);
      if (!p) throw new ValidationError(`Unknown promptId "${promptId}". Available: ${promptIds.join(', ')}`);
      if (!arxivId) throw new ValidationError('arxivId is required.');
      const paper = await getPaper(arxivId);
      return text(renderPrompt(p, paper));
    }),
  );

  return server;
}
