#!/usr/bin/env node
/**
 * End-to-end smoke test against the live arXiv API.
 * Spawns the built server over stdio, exercises every tool, and fails loudly on errors.
 *
 *   npm run smoke
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageDir = mkdtempSync(path.join(os.tmpdir(), 'arxiv-mcp-smoke-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'build', 'index.js')],
  // Run from an unrelated directory, like a real MCP client would.
  cwd: os.tmpdir(),
  env: { ...process.env, ARXIV_STORAGE_DIR: storageDir, LOG_LEVEL: 'warn' },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0.0.0' });

let failures = 0;
async function call(name, args, check) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const out = res.content.map((c) => c.text).join('\n');
  let ok = !res.isError;
  let why = res.isError ? 'tool returned isError' : '';
  if (ok && check) {
    try {
      const r = check(out);
      if (r === false) {
        ok = false;
        why = 'check failed';
      }
    } catch (e) {
      ok = false;
      why = e.message;
    }
  }
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)${why ? ` — ${why}` : ''}`);
  console.log(out.split('\n').slice(0, 8).map((l) => `     ${l.slice(0, 160)}`).join('\n'));
  return out;
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`Tools: ${tools.map((t) => t.name).join(', ')}`);
  const { prompts } = await client.listPrompts();
  console.log(`Prompts: ${prompts.map((p) => p.name).join(', ')}\n`);

  await call('list_categories', { group: 'math', search: 'combinatorics' }, (o) => o.includes('math.CO'));
  await call('list_categories', {}, (o) => o.includes('155 arXiv categories'));
  await call('search_papers', { title: 'attention is all you need', maxResults: 3 }, (o) => o.includes('1706.03762'));
  await call('search_papers', { author: 'Terence Tao', categories: ['math.CO'], submittedFrom: '2020', maxResults: 3 }, (o) => /Found \d+ papers/.test(o));
  await call('get_papers', { ids: ['1706.03762', 'hep-th/9711200', '2501.99999'] }, (o) => o.includes('hep-th/9711200') && o.includes('Not found'));
  await call('get_recent_papers', { categories: 'cs.CL', maxResults: 3 }, (o) => o.includes('most recent'));
  await call('read_paper', { arxivId: '1706.03762', maxChars: 3000 }, (o) => o.includes('Sections:'));
  await call('read_paper', { arxivId: 'https://arxiv.org/abs/1706.03762', section: 'conclusion' }, (o) => o.includes('section "'));
  await call('search_in_paper', { arxivId: '1706.03762', query: 'multi-head' }, (o) => /\d+ match/.test(o));
  await call('search_in_paper', { arxivId: '1706.03762', query: '(unbalanced[regex' }, (o) => o.includes('does not occur'));
  await call('list_downloaded_papers', {}, (o) => o.includes('1706.03762') && o.includes(storageDir));
  await call('analyze_paper', {}, (o) => o.includes('summary'));
  await call('analyze_paper', { arxivId: '1706.03762', promptId: 'summary' }, (o) => o.includes('Attention Is All You Need'));
  const prompt = await client.getPrompt({ name: 'key_findings', arguments: { arxivId: '1706.03762' } });
  console.log(`${prompt.messages.length ? 'PASS' : 'FAIL'} prompt key_findings`);
  await call('delete_paper', { arxivId: '1706.03762' }, (o) => o.includes('Deleted'));

  // Expected-error cases must come back as tool errors, not crashes.
  for (const [name, args] of [
    ['get_papers', { ids: ['../../etc/passwd'] }],
    ['search_papers', { categories: ['cs.FOO'] }],
  ]) {
    const res = await client.callTool({ name, arguments: args });
    const ok = res.isError === true;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} rejects ${JSON.stringify(args)}: ${res.content[0].text.slice(0, 140)}`);
  }
} finally {
  await client.close();
  rmSync(storageDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll smoke checks passed');
process.exit(failures ? 1 : 0);
