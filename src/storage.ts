/**
 * Local paper storage.
 *
 * Layout inside the storage directory (ARXIV_STORAGE_DIR):
 *   index.json          metadata for every downloaded paper, keyed by base arXiv ID
 *   <id>.pdf            the PDF (old-style IDs have "/" replaced by "_")
 *   <id>.txt            cached extracted text
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPaper, type Paper } from './arxiv/api.js';
import { arxivFetch } from './arxiv/http.js';
import { idToFileStem, parseArxivId } from './arxiv/ids.js';
import { config } from './config.js';
import { UpstreamError, ValidationError } from './errors.js';
import { logger } from './logger.js';

export interface StoredPaper {
  id: string;
  version: string;
  title: string;
  authors: string[];
  primaryCategory: string;
  categories: string[];
  published: string;
  summary: string;
  pdfFile: string;
  sizeBytes: number;
  downloadedAt: string;
}

const INDEX_FILE = 'index.json';

export class Storage {
  private index: Map<string, StoredPaper> | undefined;
  private inFlight = new Map<string, Promise<StoredPaper>>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {}

  pdfPath(p: StoredPaper): string {
    return path.join(this.dir, p.pdfFile);
  }

  textPath(p: StoredPaper): string {
    return path.join(this.dir, p.pdfFile.replace(/\.pdf$/, '.txt'));
  }

  private async load(): Promise<Map<string, StoredPaper>> {
    if (this.index) return this.index;
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(path.join(this.dir, INDEX_FILE), 'utf8')) as Record<string, StoredPaper>;
      this.index = new Map(Object.entries(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('Could not read storage index, starting fresh:', err);
      this.index = new Map();
    }
    return this.index;
  }

  private async save(): Promise<void> {
    const index = await this.load();
    const data = JSON.stringify(Object.fromEntries(index), null, 2);
    // Serialize writes so concurrent downloads never interleave.
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => atomicWrite(path.join(this.dir, INDEX_FILE), data));
    await this.writeChain;
  }

  /** All stored papers whose PDF still exists on disk. */
  async list(): Promise<StoredPaper[]> {
    const index = await this.load();
    let changed = false;
    for (const [id, p] of index) {
      if (!(await exists(this.pdfPath(p)))) {
        index.delete(id);
        changed = true;
      }
    }
    if (changed) await this.save();
    return [...index.values()].sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  }

  async get(id: string): Promise<StoredPaper | undefined> {
    const { base } = parseArxivId(id);
    const p = (await this.load()).get(base);
    if (p && (await exists(this.pdfPath(p)))) return p;
    return undefined;
  }

  async totalSize(): Promise<number> {
    return (await this.list()).reduce((n, p) => n + p.sizeBytes, 0);
  }

  /**
   * Download a paper's PDF (or return the stored copy). If a specific version is
   * requested and a different one is stored, the stored copy is replaced.
   */
  async download(id: string, opts: { force?: boolean } = {}): Promise<{ paper: StoredPaper; cached: boolean }> {
    const parsed = parseArxivId(id);
    const existing = await this.get(parsed.base);
    if (existing && !opts.force && (!parsed.version || existing.version === parsed.version)) {
      return { paper: existing, cached: true };
    }

    const key = parsed.full;
    let job = this.inFlight.get(key);
    if (!job) {
      job = this.doDownload(parsed.full).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, job);
    }
    return { paper: await job, cached: false };
  }

  private async doDownload(id: string): Promise<StoredPaper> {
    const meta: Paper = await getPaper(id);
    const { base, version } = parseArxivId(meta.id);

    const maxBytes = config.maxPdfSizeMb > 0 ? config.maxPdfSizeMb * 1024 * 1024 : Infinity;
    const res = await arxivFetch(meta.pdfUrl, {
      accept: 'application/pdf',
      timeoutMs: Math.max(config.requestTimeoutMs, 120_000),
      budgetMs: 150_000,
    });

    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('pdf')) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamError(
        `arXiv did not return a PDF for ${meta.id} (got "${type || 'unknown content type'}"). ` +
          'The PDF may still be generating or the paper may only be available in other formats; try again later or use the abstract page: ' +
          meta.absUrl,
      );
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new ValidationError(`PDF for ${meta.id} is ${(declared / 1048576).toFixed(1)} MB, above MAX_PDF_SIZE_MB=${config.maxPdfSizeMb}.`);
    }

    const buffer = await readLimited(res, maxBytes, meta.id);
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new UpstreamError(`The file downloaded for ${meta.id} is not a valid PDF.`);
    }

    if (config.maxStorageSizeMb > 0) {
      const old = await this.get(base);
      const used = (await this.totalSize()) - (old?.sizeBytes ?? 0);
      if (used + buffer.length > config.maxStorageSizeMb * 1024 * 1024) {
        throw new ValidationError(
          `Downloading ${meta.id} would exceed MAX_STORAGE_SIZE_MB=${config.maxStorageSizeMb}. Delete some papers with delete_paper first.`,
        );
      }
    }

    const index = await this.load();
    const previous = index.get(base);
    const pdfFile = `${idToFileStem(base)}.pdf`;
    const stored: StoredPaper = {
      id: base,
      version: version ?? '',
      title: meta.title,
      authors: meta.authors,
      primaryCategory: meta.primaryCategory,
      categories: meta.categories,
      published: meta.published,
      summary: meta.summary,
      pdfFile,
      sizeBytes: buffer.length,
      downloadedAt: new Date().toISOString(),
    };
    await atomicWrite(path.join(this.dir, pdfFile), buffer);
    // Any cached text belongs to the previous version.
    if (previous) await rm(this.textPath(previous), { force: true });
    index.set(base, stored);
    await this.save();
    logger.info(`Downloaded ${meta.id} (${(buffer.length / 1048576).toFixed(2)} MB) to ${this.pdfPath(stored)}`);
    return stored;
  }

  async delete(id: string): Promise<boolean> {
    const { base } = parseArxivId(id);
    const index = await this.load();
    const p = index.get(base);
    if (!p) return false;
    await rm(this.pdfPath(p), { force: true });
    await rm(this.textPath(p), { force: true });
    index.delete(base);
    await this.save();
    return true;
  }

  async readCachedText(p: StoredPaper): Promise<string | undefined> {
    try {
      return await readFile(this.textPath(p), 'utf8');
    } catch {
      return undefined;
    }
  }

  async writeCachedText(p: StoredPaper, text: string): Promise<void> {
    await atomicWrite(this.textPath(p), text);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function readLimited(res: Response, maxBytes: number, id: string): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new ValidationError(`PDF for ${id} exceeds MAX_PDF_SIZE_MB=${config.maxPdfSizeMb}.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export const storage = new Storage(config.storageDir);
