# Changelog

## 2.0.1

### Fixed
- Multi-word `title`, `abstract` and `all` searches containing common words returned nothing. For example, "attention is all you need" found 0 papers, because arXiv does not index words like "is", so a required `ti:is` never matches. Such words are now dropped from unquoted terms. Quoted phrases are unchanged.

## 2.0.0

A rewrite on the current MCP SDK (`McpServer`, zod schemas, tool annotations, MCP prompts).

### Fixed
- **#1: `.env` settings were ignored.** `STORAGE_DIR` was hardcoded, `dotenv.config()` ran after the modules that read settings had already loaded, and `.env` was only looked up in the client's working directory. Configuration is now loaded first, from `ARXIV_MCP_ENV_FILE`, `./.env` or the project root `.env`. Client-provided variables take precedence, and every documented variable is actually used.
- Logs were written to stdout, which is the MCP transport, and could corrupt the protocol. Logs now go to stderr (plus optional `LOG_FILE`).
- Old-style IDs such as `hep-th/9901001` came back as `9901001`.
- `search_in_paper` treated the search term as a regular expression, so characters like `(` caused errors, and empty matches looped forever. It now does a plain-text match.
- arXiv IDs were used in file paths without validation. All IDs are now validated.
- Requests used plain HTTP. They now use HTTPS.
- Concurrent tool calls could bypass the rate limit.
- `read_paper_content` returned only fragments of guessed sections, never the full text.
- The Docker image could not be built from a clean checkout.
- The README pointed to an npm package that was never published.

### Added
- **#2: `list_categories`**: the full official arXiv taxonomy (155 categories with names and descriptions), filterable by group or archive and by text. Unknown category codes in searches are rejected with suggestions.
- `search_papers`: submission-date ranges, multiple categories, `fullAbstracts`, and paging hints. The raw `query` can be combined with the field filters.
- `read_paper`: full text with paging, section listing and section lookup. It downloads automatically and caches the extracted text.
- Analysis templates are exposed as MCP prompts. Custom templates can be added with `PROMPTS_FILE`.
- Retries with backoff, a time budget that stays under client timeouts, a clear message when arXiv rate-limits, and a short-lived response cache.
- `MAX_PDF_SIZE_MB` and `MAX_STORAGE_SIZE_MB` are enforced.
- Unit tests (`npm test`) and a live end-to-end smoke test (`npm run smoke`).

### Changed (breaking)
- Requires Node.js 22+.
- Tools renamed or merged:
  - `get_paper_by_id` → `get_papers`
  - `read_paper_content` → `read_paper`
  - `search_author` → `search_papers` with `author`
  - `get_storage_stats` → included in `list_downloaded_papers`
  - `get_analysis_prompts` → `analyze_paper` without `promptId`
- `search_papers.category` → `categories`, and `get_recent_papers.category` → `categories`. Both accept a single code or a list.
- `search_in_paper.searchTerm` → `query`.
- The default storage location moved from `<install dir>/storage` to `~/.arxiv-mcp-server/papers`. Set `ARXIV_STORAGE_DIR` to keep using the old folder. Papers stored in the old format will need to be downloaded again.
- Dependencies: dropped axios, node-fetch, xml2js, pdf-parse, winston and dotenv in favour of native `fetch`, fast-xml-parser and unpdf.
