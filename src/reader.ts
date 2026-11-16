/**
 * Full-text access to papers: downloads on demand, extracts once, caches the text.
 */
import { detectSections, extractPdfText, type Section } from './pdf.js';
import { storage, type StoredPaper } from './storage.js';

export interface PaperText {
  paper: StoredPaper;
  text: string;
  sections: Section[];
  /** True when the PDF had to be downloaded for this call. */
  downloaded: boolean;
}

const memo = new Map<string, { key: string; text: string; sections: Section[] }>();

export async function getPaperText(id: string): Promise<PaperText> {
  const { paper, cached } = await storage.download(id);
  const key = `${paper.id}${paper.version}:${paper.downloadedAt}`;
  const hit = memo.get(paper.id);
  if (hit && hit.key === key) return { paper, text: hit.text, sections: hit.sections, downloaded: !cached };

  let text = await storage.readCachedText(paper);
  if (text === undefined) {
    text = await extractPdfText(storage.pdfPath(paper));
    await storage.writeCachedText(paper, text);
  }
  const sections = detectSections(text);
  memo.set(paper.id, { key, text, sections });
  // Keep the in-memory cache small.
  if (memo.size > 20) memo.delete(memo.keys().next().value!);
  return { paper, text, sections, downloaded: !cached };
}

export function forget(id: string): void {
  memo.delete(id);
}
