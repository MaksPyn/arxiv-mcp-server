/**
 * The arXiv category taxonomy (issue #2).
 * Data is generated from https://arxiv.org/category_taxonomy by scripts/update-categories.mjs.
 */
import data from './categories.json' with { type: 'json' };

export interface Category {
  code: string;
  name: string;
  group: string;
  groupName: string;
  archive?: string;
  archiveName?: string;
  description: string;
}

export interface CategoryGroup {
  id: string;
  name: string;
  categories: Category[];
}

export const TAXONOMY_SOURCE = data.source;
export const TAXONOMY_RETRIEVED = data.retrieved;

export const CATEGORY_GROUPS: CategoryGroup[] = data.groups.map((g) => ({
  id: g.id,
  name: g.name,
  categories: g.categories.map((c) => ({ ...c, group: g.id, groupName: g.name })),
}));

export const CATEGORIES: Category[] = CATEGORY_GROUPS.flatMap((g) => g.categories);

const BY_CODE = new Map(CATEGORIES.map((c) => [c.code.toLowerCase(), c]));

export function getCategory(code: string): Category | undefined {
  return BY_CODE.get(code.trim().toLowerCase());
}

/**
 * Valid values for a `cat:` query: an exact category code (cs.AI), an archive
 * (astro-ph, cond-mat, nlin, physics) or a whole group (cs, math, q-bio ...).
 */
export function isKnownCategoryOrArchive(code: string): boolean {
  const c = code.trim().toLowerCase();
  return (
    BY_CODE.has(c) ||
    CATEGORY_GROUPS.some((g) => g.id.toLowerCase() === c) ||
    CATEGORIES.some((cat) => cat.archive?.toLowerCase() === c)
  );
}

/** Canonical casing for a category code (e.g. "CS.ai" -> "cs.AI"); unknown codes are returned trimmed. */
export function canonicalCategory(code: string): string {
  return getCategory(code)?.code ?? code.trim();
}

/** Closest known codes for an unknown category, used to give helpful errors. */
export function suggestCategories(code: string, limit = 5): string[] {
  const c = code.trim().toLowerCase();
  const prefix = c.split('.')[0] ?? c;
  const scored = CATEGORIES.map((cat) => {
    const k = cat.code.toLowerCase();
    let score = 0;
    if (k.startsWith(prefix)) score += 2;
    if (k.includes(c) || c.includes(k)) score += 3;
    if (cat.name.toLowerCase().includes(c)) score += 2;
    return { code: cat.code, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.code);
}

/** Filter the taxonomy by group and/or free-text search over code, name and description. */
export function findCategories(opts: { group?: string; search?: string }): Category[] {
  let list = CATEGORIES;
  if (opts.group) {
    const g = opts.group.trim().toLowerCase();
    list = list.filter(
      (c) => c.group.toLowerCase() === g || c.groupName.toLowerCase() === g || c.archive?.toLowerCase() === g,
    );
  }
  if (opts.search) {
    const terms = opts.search.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((c) => {
      const hay = `${c.code} ${c.name} ${c.archiveName ?? ''} ${c.description}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  return list;
}
