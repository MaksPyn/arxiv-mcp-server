/**
 * Research-analysis prompt templates.
 *
 * Bundled templates live in prompts/prompts.json. Users can add or override
 * templates with their own JSON file (same format) via PROMPTS_FILE.
 * Templates are read-only at runtime: the server never writes into its own
 * install directory.
 *
 * Template variables: {{id}} {{title}} {{authors}} {{abstract}} {{categories}}
 * {{primaryCategory}} {{year}} {{published}} {{url}} {{comment}} {{journalRef}} {{doi}}
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Paper } from './arxiv/api.js';
import { config, PACKAGE_ROOT } from './config.js';
import { logger } from './logger.js';

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
}

function loadFile(file: string): PromptTemplate[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<PromptTemplate>> | Partial<PromptTemplate>[];
    const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, p]) => ({ id, ...p }));
    return list.filter((p): p is PromptTemplate => {
      const ok = Boolean(p.id && p.template);
      if (!ok) logger.warn(`Skipping invalid prompt template in ${file}:`, p);
      return ok;
    }).map((p) => ({ ...p, name: p.name ?? p.id, description: p.description ?? '' }));
  } catch (err) {
    logger.error(`Could not load prompt templates from ${file}:`, err);
    return [];
  }
}

export function loadPrompts(): PromptTemplate[] {
  const byId = new Map<string, PromptTemplate>();
  for (const p of loadFile(path.join(PACKAGE_ROOT, 'prompts', 'prompts.json'))) byId.set(p.id, p);
  if (config.promptsFile) for (const p of loadFile(config.promptsFile)) byId.set(p.id, p);
  return [...byId.values()];
}

export function paperVariables(paper: Paper): Record<string, string> {
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors.join(', '),
    abstract: paper.summary,
    categories: paper.categories.join(', '),
    primaryCategory: paper.primaryCategory,
    year: paper.published.slice(0, 4),
    published: paper.published.slice(0, 10),
    url: paper.absUrl,
    comment: paper.comment ?? '',
    journalRef: paper.journalRef ?? '',
    doi: paper.doi ?? '',
  };
}

export function renderPrompt(template: PromptTemplate, paper: Paper): string {
  const vars = paperVariables(paper);
  const body = template.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => vars[name] ?? `[${name} unavailable]`);
  return (
    body +
    `\n\nThe full text of this paper (arXiv:${paper.id}) can be read with the read_paper tool ` +
    `(use its "section" argument to jump to specific sections). Base your analysis on the full text, not just the abstract, when possible.`
  );
}
