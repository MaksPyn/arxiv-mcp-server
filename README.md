# arXiv MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants access to [arXiv](https://arxiv.org): search papers, browse the official category taxonomy, and read papers' full text.

- **Search** by keywords, title, author, abstract, category and submission date, with paging and sorting
- **Category taxonomy**: all 155 official arXiv categories (`cs.AI`, `math.CO`, `astro-ph.CO`, …) with descriptions
- **Full text**: `read_paper` downloads the PDF, extracts the text, detects sections, and returns it in chunks you can page through or jump into by section
- **In-paper search**: find every occurrence of a phrase, with context and section names
- **Local library**: downloaded papers are kept on disk and can be listed and deleted
- **Analysis prompts**: summary, key findings, methodology critique, literature-review entry and more, available as MCP prompts and as a tool
- **Polite to arXiv**: all requests share one queue with a 3-second gap, retry with backoff, and cache responses for a short time

## Requirements

Node.js 22 or newer.

## Installation

### Run straight from GitHub (no clone)

```json
{
  "mcpServers": {
    "arxiv": {
      "command": "npx",
      "args": ["-y", "github:MaksPyn/arxiv-mcp-server"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/MaksPyn/arxiv-mcp-server.git
cd arxiv-mcp-server
npm install        # also builds into build/
```

Then point your MCP client at `build/index.js`.

**Claude Desktop**: edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "arxiv": {
      "command": "node",
      "args": ["/absolute/path/to/arxiv-mcp-server/build/index.js"],
      "env": {
        "ARXIV_STORAGE_DIR": "/absolute/path/to/papers"
      }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add arxiv -e ARXIV_STORAGE_DIR=~/papers -- node /absolute/path/to/arxiv-mcp-server/build/index.js
```

### Docker

```bash
docker build -t arxiv-mcp-server -f docker/Dockerfile .
```

```json
{
  "mcpServers": {
    "arxiv": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "arxiv-data:/data", "arxiv-mcp-server"]
    }
  }
}
```

## Configuration

Settings come from environment variables. The easiest place to set them is the `env` block of your MCP client config (see above). You can also use a `.env` file. The server looks for one in these places, highest priority first:

1. the file named by `ARXIV_MCP_ENV_FILE`
2. `.env` in the working directory the client launched the server from
3. `.env` in the project root (next to `package.json`)

Variables set by the client always override `.env` files. Relative paths in a `.env` file are resolved against that file's directory. When the server starts, it logs the storage directory in use and which `.env` files it loaded. `list_downloaded_papers` also shows the storage directory.

| Variable | Default | Description |
| --- | --- | --- |
| `ARXIV_STORAGE_DIR` (or `STORAGE_DIR`) | `~/.arxiv-mcp-server/papers` | Where PDFs and extracted text are stored |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. Logs go to stderr |
| `LOG_FILE` | – | Also append logs to this file |
| `RATE_LIMIT_DELAY_MS` | `3000` | Minimum gap between requests to arXiv |
| `REQUEST_TIMEOUT_MS` | `20000` | Per-request timeout for API calls |
| `MAX_PDF_SIZE_MB` | `50` | Refuse larger PDFs (`0` = no limit) |
| `MAX_STORAGE_SIZE_MB` | `0` | Refuse downloads once storage exceeds this (`0` = no limit) |
| `PROMPTS_FILE` | – | JSON file with extra or overriding analysis prompts |

See [`config/.env.example`](config/.env.example).

## Tools

| Tool | What it does |
| --- | --- |
| `search_papers` | Search with any of `all`, `title`, `author`, `abstract`, `categories`, `submittedFrom`/`submittedTo`, or a raw arXiv `query`. Supports `sortBy`, `sortOrder`, `start`, `maxResults` (≤ 200) and `fullAbstracts` |
| `get_papers` | Full metadata for one or more IDs or arxiv.org URLs (new-style `2301.00001v2` and old-style `hep-th/9901001`) |
| `get_recent_papers` | Newest submissions in one or more categories |
| `list_categories` | The arXiv category taxonomy, filterable by `group` (`cs`, `math`, `physics`, `astro-ph`, …) and `search` text |
| `read_paper` | Full text of a paper, downloaded automatically. Page with `offset`/`maxChars`, or jump with `section` (`"Introduction"`, `"3.2"`, `"conclusion"`) |
| `search_in_paper` | Every occurrence of a word or phrase, with context and section names. Plain-text match, not regex |
| `download_paper` | Download a PDF ahead of time (`force` to re-download) |
| `list_downloaded_papers` | Local library, storage usage and storage directory |
| `delete_paper` | Remove a paper from local storage |
| `analyze_paper` | A filled-in research-analysis brief. Omit `promptId` to list the available analyses |

### Search tips

- Words in `title`/`abstract`/`all` must all match. Use `"double quotes"` for an exact phrase.
- `categories` takes one code or a list (matched with OR). Whole archives such as `math` or `cond-mat` also work. Unknown codes are rejected with suggestions.
- Dates accept `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
- `query` takes raw [arXiv query syntax](https://info.arxiv.org/help/api/user-manual.html#query_details), e.g. `ti:"diffusion model" ANDNOT cat:cs.CV`, and is combined with the other fields using AND.

## Prompts

Each template in [`prompts/prompts.json`](prompts/prompts.json) is exposed as an MCP prompt that takes an `arxivId`: `summary`, `key_findings`, `methodology_analysis`, `literature_review`, `research_gaps`, `technical_deep_dive`, `comparison`, `practical_applications`. In clients that support prompts, such as Claude Desktop and Claude Code, they show up as slash commands or attachments.

To add your own, create a JSON file in the same format and set `PROMPTS_FILE`. Entries with the same `id` replace the built-in ones. Templates can use `{{id}}`, `{{title}}`, `{{authors}}`, `{{abstract}}`, `{{categories}}`, `{{primaryCategory}}`, `{{year}}`, `{{published}}`, `{{url}}`, `{{comment}}`, `{{journalRef}}` and `{{doi}}`.

## Development

```bash
npm run build     # compile to build/
npm test          # offline unit tests
npm run smoke     # end-to-end test against the live arXiv API
node scripts/update-categories.mjs   # refresh the category list from arxiv.org
```

```
src/
  index.ts            entry point (stdio transport)
  server.ts           tool and prompt definitions
  config.ts           environment / .env loading
  logger.ts           stderr logger
  arxiv/api.ts        Atom API client and parser
  arxiv/http.ts       rate-limited, retrying fetch
  arxiv/query.ts      search query builder
  arxiv/ids.ts        arXiv ID parsing and validation
  arxiv/categories.*  category taxonomy
  storage.ts          local paper storage
  pdf.ts              PDF text extraction, section detection, search
  reader.ts           download, extract and cache
  prompts.ts          analysis prompt templates
```

## Notes

- arXiv asks API users to keep to one request every 3 seconds. If you send too many, arXiv answers with HTTP 429 for a while. The server reports this clearly, and papers you've already downloaded can still be read.
- Text is extracted from the PDF, so equations, tables and figures come through imperfectly.
- Section detection is heuristic. If a section isn't found, the error lists the detected sections, and you can always read by `offset`.

## License

MIT. Thanks to arXiv for use of its open-access interoperability.
