// Offline unit tests. Run with `npm test` (builds first).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../build/config.js';
import { idFromEntryUrl, parseArxivId } from '../build/arxiv/ids.js';
import { buildSearchQuery, toArxivDate, tokenize } from '../build/arxiv/query.js';
import { CATEGORIES, findCategories, getCategory, isKnownCategoryOrArchive } from '../build/arxiv/categories.js';
import { parseFeed } from '../build/arxiv/api.js';
import { detectSections, findSection, searchText } from '../build/pdf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, 'fixtures', name), 'utf8');

// --- Issue #1: configuration from .env ------------------------------------

test('config: STORAGE_DIR from a .env file is honoured (issue #1)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arxiv-cfg-'));
  writeFileSync(path.join(dir, '.env'), 'STORAGE_DIR=./my-papers\nRATE_LIMIT_DELAY_MS=5000\nLOG_LEVEL=debug\n');
  const cfg = loadConfig({}, dir);
  assert.equal(cfg.storageDir, path.join(dir, 'my-papers'));
  assert.equal(cfg.rateLimitDelayMs, 5000);
  assert.equal(cfg.logLevel, 'debug');
  assert.ok(cfg.envFilesLoaded.includes(path.join(dir, '.env')));
});

test('config: ARXIV_MCP_ENV_FILE is used even when cwd is elsewhere; relative paths resolve against that file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arxiv-cfg-'));
  mkdirSync(path.join(dir, 'conf'));
  writeFileSync(path.join(dir, 'conf', 'arxiv.env'), 'ARXIV_STORAGE_DIR=../store\n');
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'arxiv-cwd-'));
  const cfg = loadConfig({ ARXIV_MCP_ENV_FILE: path.join(dir, 'conf', 'arxiv.env') }, elsewhere);
  assert.equal(cfg.storageDir, path.join(dir, 'store'));
});

test('config: variables set by the MCP client override .env, and ARXIV_STORAGE_DIR beats STORAGE_DIR', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arxiv-cfg-'));
  writeFileSync(path.join(dir, '.env'), 'STORAGE_DIR=/from/dotenv\nARXIV_STORAGE_DIR=/from/dotenv2\n');
  assert.equal(loadConfig({}, dir).storageDir, '/from/dotenv2');
  assert.equal(loadConfig({ ARXIV_STORAGE_DIR: '/from/client' }, dir).storageDir, '/from/client');
});

test('config: ~ is expanded and bad numbers fall back to defaults', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arxiv-cfg-'));
  const cfg = loadConfig({ STORAGE_DIR: '~/papers', RATE_LIMIT_DELAY_MS: 'abc' }, dir);
  assert.equal(cfg.storageDir, path.join(os.homedir(), 'papers'));
  assert.equal(cfg.rateLimitDelayMs, 3000);
});

// --- IDs ------------------------------------------------------------------

test('ids: new-style, old-style, versions, prefixes and URLs', () => {
  assert.deepEqual(parseArxivId('2301.00001'), { base: '2301.00001', version: undefined, full: '2301.00001' });
  assert.equal(parseArxivId('2301.00001v3').full, '2301.00001v3');
  assert.equal(parseArxivId('arXiv:0704.0001').base, '0704.0001');
  assert.equal(parseArxivId('hep-th/9901001').base, 'hep-th/9901001');
  assert.equal(parseArxivId('math.CO/0501001v2').full, 'math.CO/0501001v2');
  assert.equal(parseArxivId('https://arxiv.org/abs/1706.03762v7').full, '1706.03762v7');
  assert.equal(parseArxivId('https://arxiv.org/pdf/1706.03762.pdf').base, '1706.03762');
  assert.equal(parseArxivId('http://export.arxiv.org/abs/hep-th/9711200').base, 'hep-th/9711200');
});

test('ids: rejects path traversal and garbage', () => {
  for (const bad of ['../../etc/passwd', '2301.00001/../../x', '', 'hello', '2301.1', 'hep-th/99']) {
    assert.throws(() => parseArxivId(bad), /not a valid arXiv identifier/, bad);
  }
});

test('ids: entry URLs keep old-style archive prefix (was split("/").pop())', () => {
  assert.equal(idFromEntryUrl('http://arxiv.org/abs/hep-th/9901001v1'), 'hep-th/9901001v1');
  assert.equal(idFromEntryUrl('http://arxiv.org/abs/2301.00001v2'), '2301.00001v2');
});

// --- Query building -------------------------------------------------------

test('query: fields, phrases, categories and date ranges', () => {
  assert.equal(buildSearchQuery({ title: 'graph neural' }), '(ti:graph AND ti:neural)');
  assert.equal(buildSearchQuery({ title: '"graph neural" network' }), '(ti:"graph neural" AND ti:network)');
  assert.equal(buildSearchQuery({ author: 'Geoffrey Hinton' }), 'au:"Geoffrey Hinton"');
  assert.equal(buildSearchQuery({ categories: ['CS.ai', 'cs.lg'] }), '(cat:cs.AI OR cat:cs.LG)');
  assert.equal(buildSearchQuery({ categories: ['astro-ph'] }), 'cat:astro-ph');
  assert.equal(
    buildSearchQuery({ all: 'quantum', submittedFrom: '2024-02', submittedTo: '2024' }),
    'all:quantum AND submittedDate:[202402010000 TO 202412312359]',
  );
  assert.equal(buildSearchQuery({ query: 'ti:a OR ti:b', author: 'X' }), '(ti:a OR ti:b) AND au:X');
});

test('query: stopwords are dropped from unquoted terms but kept in phrases', () => {
  assert.equal(buildSearchQuery({ title: 'attention is all you need' }), '(ti:attention AND ti:need)');
  assert.equal(buildSearchQuery({ title: '"attention is all you need"' }), 'ti:"attention is all you need"');
  assert.equal(buildSearchQuery({ all: 'the' }), 'all:the');
});

test('query: user input cannot inject syntax', () => {
  assert.deepEqual(tokenize('foo) OR (bar AND'), ['foo', 'bar']);
  assert.equal(buildSearchQuery({ author: 'Smith" OR au:"Jones' }), 'au:"Smith OR au: Jones"');
});

test('query: validation errors', () => {
  assert.throws(() => buildSearchQuery({}), /at least one search criterion/);
  assert.throws(() => buildSearchQuery({ categories: ['cs.FOO'] }), /Unknown arXiv category "cs.FOO".*Did you mean/);
  assert.throws(() => buildSearchQuery({ all: 'x', submittedFrom: '2024-13-01' }), /Invalid date/);
  assert.throws(() => buildSearchQuery({ all: 'x', submittedFrom: '2025', submittedTo: '2024' }), /on or before/);
  assert.equal(toArxivDate('2024-02', true), '202402292359'); // leap year
});

// --- Categories (issue #2) ------------------------------------------------

test('categories: full taxonomy is present', () => {
  assert.ok(CATEGORIES.length >= 150, `only ${CATEGORIES.length} categories`);
  for (const code of ['cs.AI', 'math.CO', 'astro-ph.CO', 'cond-mat.str-el', 'q-bio.NC', 'q-fin.ST', 'stat.ML', 'eess.SP', 'econ.EM', 'quant-ph', 'hep-th']) {
    assert.ok(getCategory(code), code);
  }
  assert.equal(getCategory('cs.ai').code, 'cs.AI');
  assert.equal(getCategory('math.CO').name, 'Combinatorics');
  assert.ok(isKnownCategoryOrArchive('cond-mat'));
  assert.ok(isKnownCategoryOrArchive('math'));
  assert.ok(!isKnownCategoryOrArchive('cs.XYZ'));
});

test('categories: filtering by group and text', () => {
  assert.ok(findCategories({ group: 'q-fin' }).every((c) => c.code.startsWith('q-fin.')));
  assert.ok(findCategories({ group: 'astro-ph' }).every((c) => c.code.startsWith('astro-ph')));
  assert.ok(findCategories({ search: 'number theory' }).some((c) => c.code === 'math.NT'));
  assert.deepEqual(findCategories({ search: 'zzzz-nothing' }), []);
});

// --- Feed parsing ---------------------------------------------------------

test('feed: parses entries, old-style IDs, affiliations, DOI, https links', () => {
  const r = parseFeed(fixture('feed.xml'));
  assert.equal(r.totalResults, 2);
  const [a, b] = r.papers;
  assert.equal(a.id, '1706.03762v7');
  assert.equal(a.baseId, '1706.03762');
  assert.equal(a.title, 'Attention Is All You Need');
  assert.deepEqual(a.authors, ['Ashish Vaswani', 'Noam Shazeer']);
  assert.deepEqual(a.affiliations, { 'Ashish Vaswani': 'Google Brain' });
  assert.equal(a.primaryCategory, 'cs.CL');
  assert.deepEqual(a.categories, ['cs.CL', 'cs.LG']);
  assert.equal(a.comment, '15 pages, 5 figures');
  assert.equal(a.pdfUrl, 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(b.id, 'hep-th/9711200v3');
  assert.equal(b.doi, '10.1023/A:1026654312961');
  assert.equal(b.journalRef, 'Adv.Theor.Math.Phys.2:231-252,1998');
  assert.equal(b.pdfUrl, 'https://arxiv.org/pdf/hep-th/9711200v3');
});

test('feed: arXiv error entries become validation errors', () => {
  assert.throws(() => parseFeed(fixture('error.xml')), /arXiv rejected the query: incorrect id format/);
});

// --- Full-text helpers ----------------------------------------------------

const PAPER = [
  'Some Title',
  'Contents',
  '1 Introduction 3',
  '2 Related Work 5',
  'Abstract',
  'We study things.',
  '1 Introduction',
  'Intro text mentions attention (a lot).',
  '2 Related Work',
  'Prior art.',
  '3 Method',
  '3.1 Multi-Head Attention',
  'Details about attention heads.',
  'Table 1: 2017 1234 5678 results',
  '4 N 2 dt2 + g2',
  '4 Conclusion',
  'We conclude.',
  'References',
  '[1] A. Author. A paper. 2017.',
  'A Proofs',
  'Appendix content.',
].join('\n');

test('sections: detects numbered and named headings', () => {
  const titles = detectSections(PAPER).map((s) => s.title);
  assert.deepEqual(titles, [
    'Abstract',
    '1 Introduction',
    '2 Related Work',
    '3 Method',
    '3.1 Multi-Head Attention',
    '4 Conclusion',
    'References',
    'A Proofs',
  ]);
});

test('sections: lookup by name, number and keyword', () => {
  const s = detectSections(PAPER);
  assert.equal(findSection(s, 'introduction').title, '1 Introduction');
  assert.equal(findSection(s, '3.1').title, '3.1 Multi-Head Attention');
  assert.equal(findSection(s, 'conclusion').title, '4 Conclusion');
  assert.equal(findSection(s, 'multi-head').title, '3.1 Multi-Head Attention');
  assert.equal(findSection(s, 'nonexistent'), undefined);
});

test('search: literal matching (regex characters are safe) with section labels', () => {
  const sections = detectSections(PAPER);
  const r = searchText(PAPER, 'attention', { sections });
  assert.equal(r.total, 3);
  assert.equal(r.matches[0].section, '1 Introduction');
  assert.equal(searchText(PAPER, '(a lot)').total, 1);
  assert.equal(searchText(PAPER, '[unbalanced(').total, 0);
  assert.equal(searchText(PAPER, 'ATTENTION', { caseSensitive: true }).total, 0);
});
