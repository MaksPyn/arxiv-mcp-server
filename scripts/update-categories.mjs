#!/usr/bin/env node
/**
 * Regenerates src/arxiv/categories.json from the official arXiv taxonomy page.
 *
 *   node scripts/update-categories.mjs                # fetches https://arxiv.org/category_taxonomy
 *   node scripts/update-categories.mjs taxonomy.html  # parses a local copy
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://arxiv.org/category_taxonomy';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'arxiv', 'categories.json');

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const html = process.argv[2]
  ? await readFile(process.argv[2], 'utf8')
  : await (await fetch(SOURCE_URL, { headers: { 'User-Agent': 'arxiv-mcp-server category updater' } })).text();

const start = html.indexOf('id="category_taxonomy_list"');
if (start < 0) throw new Error('Could not find the taxonomy list in the page; the layout may have changed.');
const body = html.slice(start);

// Tokenise the page into group headings (h2), archive headings (h3), and category blocks (h4 + description).
const token =
  /<h2 class="accordion-head" id="accordion-head-grp_([^"]+)">[\s\S]*?<\/span>\s*([^<]+?)\s*<\/button>|<h3>([\s\S]*?)<\/h3>|<h4>([^<\s]+)\s*<span>\(([\s\S]*?)\)<\/span><\/h4>\s*<\/div>\s*<div class="column">([\s\S]*?)<\/div>/g;

const groups = [];
let group = null;
let archive = null;
for (const m of body.matchAll(token)) {
  if (m[1]) {
    group = { id: m[1], name: decode(m[2]), categories: [] };
    archive = null;
    groups.push(group);
  } else if (m[3] !== undefined) {
    const a = m[3].match(/^([\s\S]*?)<br>\s*<span>\(([^)]+)\)<\/span>/);
    archive = a ? { id: a[2].trim(), name: decode(a[1]) } : null;
  } else if (m[4] && group) {
    const code = m[4].trim();
    group.categories.push({
      code,
      name: decode(m[5]),
      ...(archive && code.startsWith(archive.id) ? { archive: archive.id, archiveName: archive.name } : {}),
      description: decode(m[6]),
    });
  }
}

const total = groups.reduce((n, g) => n + g.categories.length, 0);
if (groups.length < 5 || total < 100) throw new Error(`Parsed only ${groups.length} groups / ${total} categories; aborting.`);

await writeFile(
  OUT,
  JSON.stringify({ source: SOURCE_URL, retrieved: new Date().toISOString().slice(0, 10), groups }, null, 2) + '\n',
);
console.log(`Wrote ${total} categories in ${groups.length} groups to ${path.relative(process.cwd(), OUT)}`);
