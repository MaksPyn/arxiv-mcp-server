#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
dotenv.config();

// Import types
import { ArxivEntry, SearchResult, ArxivCategories } from './types/index.js';

// Import utilities
import logger from './utils/logger.js';
import { NetworkError, ValidationError, retryWithBackoff } from './utils/errors.js';
import { readJsonFile } from './utils/fileUtils.js';

// Import managers
import { storageManager } from './storage/storageManager.js';
import { promptManager } from './prompts/promptManager.js';
import { pdfReader } from './utils/pdfReader.js';

const ARXIV_API_BASE = 'http://export.arxiv.org/api/query';
const RATE_LIMIT_DELAY = 3000; // 3 seconds as recommended by arXiv

class ArxivServer {
  private server: Server;
  private lastRequestTime: number = 0;

  constructor() {
    this.server = new Server(
      {
        name: 'arxiv-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.initializeManagers();
    
    // Error handling
    this.server.onerror = (error) => logger.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async initializeManagers() {
    try {
      await storageManager.initialize();
      await promptManager.initialize();
      logger.info('Managers initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize managers:', error);
    }
  }

  private async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  private parseArxivResponse(data: any): SearchResult {
    const feed = data.feed;
    const entries = feed.entry || [];
    
    return {
      totalResults: parseInt(feed['opensearch:totalResults']?.[0] || '0'),
      startIndex: parseInt(feed['opensearch:startIndex']?.[0] || '0'),
      itemsPerPage: parseInt(feed['opensearch:itemsPerPage']?.[0] || '0'),
      entries: (Array.isArray(entries) ? entries : [entries]).map((entry: any) => ({
        id: entry.id[0],
        updated: entry.updated[0],
        published: entry.published[0],
        title: entry.title[0].trim(),
        summary: entry.summary[0].trim(),
        authors: (entry.author || []).map((author: any) => ({
          name: author.name[0],
          affiliation: author['arxiv:affiliation']?.[0]?.['_'],
        })),
        categories: (entry.category || []).map((cat: any) => cat['$'].term),
        primaryCategory: entry['arxiv:primary_category']?.[0]?.['$']?.term || '',
        links: (entry.link || []).map((link: any) => ({
          href: link['$'].href,
          type: link['$'].type,
          title: link['$'].title,
        })),
        comment: entry['arxiv:comment']?.[0],
        journalRef: entry['arxiv:journal_ref']?.[0],
        doi: entry['arxiv:doi']?.[0],
      })),
    };
  }

  private formatSearchQuery(params: any): string {
    const parts: string[] = [];
    
    if (params.title) {
      parts.push(`ti:"${params.title}"`);
    }
    if (params.author) {
      parts.push(`au:"${params.author}"`);
    }
    if (params.abstract) {
      parts.push(`abs:"${params.abstract}"`);
    }
    if (params.category) {
      parts.push(`cat:${params.category}`);
    }
    if (params.all) {
      parts.push(`all:"${params.all}"`);
    }
    
    // If no specific fields, use the query parameter as-is
    if (parts.length === 0 && params.query) {
      return params.query;
    }
    
    return parts.join(' AND ');
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_papers',
          description: 'Search for papers on arXiv using various criteria',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Raw search query (use this OR the specific fields below)',
              },
              title: {
                type: 'string',
                description: 'Search in paper titles',
              },
              author: {
                type: 'string',
                description: 'Search by author name',
              },
              abstract: {
                type: 'string',
                description: 'Search in abstracts',
              },
              category: {
                type: 'string',
                description: 'Filter by category (e.g., cs.AI, math.CO)',
              },
              all: {
                type: 'string',
                description: 'Search in all fields',
              },
              start: {
                type: 'number',
                description: 'Starting index (0-based)',
                default: 0,
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results (max 2000)',
                default: 10,
              },
              sortBy: {
                type: 'string',
                enum: ['relevance', 'lastUpdatedDate', 'submittedDate'],
                description: 'Sort order for results',
                default: 'relevance',
              },
              sortOrder: {
                type: 'string',
                enum: ['ascending', 'descending'],
                description: 'Sort direction',
                default: 'descending',
              },
            },
          },
        },
        {
          name: 'get_paper_by_id',
          description: 'Get specific paper(s) by arXiv ID',
          inputSchema: {
            type: 'object',
            properties: {
              ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of arXiv IDs (e.g., ["2301.00001", "hep-th/9901001"])',
              },
            },
            required: ['ids'],
          },
        },
        {
          name: 'get_recent_papers',
          description: 'Get the most recent papers in a category',
          inputSchema: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'Category to filter by (e.g., cs.AI, physics.quant-ph)',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results',
                default: 10,
              },
            },
            required: ['category'],
          },
        },
        {
          name: 'search_author',
          description: 'Find all papers by a specific author',
          inputSchema: {
            type: 'object',
            properties: {
              author: {
                type: 'string',
                description: 'Author name to search for',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results',
                default: 20,
              },
              sortBy: {
                type: 'string',
                enum: ['submittedDate', 'lastUpdatedDate'],
                default: 'submittedDate',
              },
            },
            required: ['author'],
          },
        },
        {
          name: 'download_paper',
          description: 'Download a paper PDF and store it locally',
          inputSchema: {
            type: 'object',
            properties: {
              arxivId: {
                type: 'string',
                description: 'arXiv ID of the paper to download',
              },
            },
            required: ['arxivId'],
          },
        },
        {
          name: 'list_downloaded_papers',
          description: 'List all locally downloaded papers',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'delete_paper',
          description: 'Delete a downloaded paper from local storage',
          inputSchema: {
            type: 'object',
            properties: {
              arxivId: {
                type: 'string',
                description: 'arXiv ID of the paper to delete',
              },
            },
            required: ['arxivId'],
          },
        },
        {
          name: 'get_storage_stats',
          description: 'Get storage statistics for downloaded papers',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'read_paper_content',
          description: 'Read and extract text content from a downloaded paper',
          inputSchema: {
            type: 'object',
            properties: {
              arxivId: {
                type: 'string',
                description: 'arXiv ID of the paper to read',
              },
            },
            required: ['arxivId'],
          },
        },
        {
          name: 'search_in_paper',
          description: 'Search for text within a downloaded paper',
          inputSchema: {
            type: 'object',
            properties: {
              arxivId: {
                type: 'string',
                description: 'arXiv ID of the paper to search in',
              },
              searchTerm: {
                type: 'string',
                description: 'Text to search for',
              },
              caseSensitive: {
                type: 'boolean',
                description: 'Whether the search should be case sensitive',
                default: false,
              },
            },
            required: ['arxivId', 'searchTerm'],
          },
        },
        {
          name: 'get_analysis_prompts',
          description: 'Get available research analysis prompts',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'analyze_paper',
          description: 'Generate an analysis prompt for a paper',
          inputSchema: {
            type: 'object',
            properties: {
              arxivId: {
                type: 'string',
                description: 'arXiv ID of the paper to analyze',
              },
              promptId: {
                type: 'string',
                description: 'ID of the analysis prompt to use',
              },
            },
            required: ['arxivId', 'promptId'],
          },
        },
        {
          name: 'get_arxiv_categories',
          description: 'Get arXiv category information. If no group is specified, returns all group names. If a group is specified, returns detailed information for that group.',
          inputSchema: {
            type: 'object',
            properties: {
              group: {
                type: 'string',
                description: 'Optional. The group name to get detailed category information for.',
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_papers':
            return await this.searchPapers(args);
          case 'get_paper_by_id':
            return await this.getPaperById(args);
          case 'get_recent_papers':
            return await this.getRecentPapers(args);
          case 'search_author':
            return await this.searchAuthor(args);
          case 'download_paper':
            return await this.downloadPaper(args);
          case 'list_downloaded_papers':
            return await this.listDownloadedPapers();
          case 'delete_paper':
            return await this.deletePaper(args);
          case 'get_storage_stats':
            return await this.getStorageStats();
          case 'read_paper_content':
            return await this.readPaperContent(args);
          case 'search_in_paper':
            return await this.searchInPaper(args);
          case 'get_analysis_prompts':
            return await this.getAnalysisPrompts();
          case 'analyze_paper':
            return await this.analyzePaper(args);
          case 'get_arxiv_categories':
            return await this.getArxivCategories(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async searchPapers(args: any) {
    await this.enforceRateLimit();

    const searchQuery = this.formatSearchQuery(args);
    const params = new URLSearchParams({
      search_query: searchQuery,
      start: String(args.start || 0),
      max_results: String(Math.min(args.maxResults || 10, 2000)),
    });

    if (args.sortBy) {
      params.append('sortBy', args.sortBy);
    }
    if (args.sortOrder) {
      params.append('sortOrder', args.sortOrder);
    }

    const response = await axios.get(`${ARXIV_API_BASE}?${params}`);
    const parsed = await parseStringPromise(response.data);
    const result = this.parseArxivResponse(parsed);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            totalResults: result.totalResults,
            showing: `${result.startIndex + 1}-${result.startIndex + result.entries.length}`,
            papers: result.entries.map(entry => ({
              id: entry.id.split('/').pop(),
              title: entry.title,
              authors: entry.authors.map(a => a.name).join(', '),
              published: entry.published.split('T')[0],
              categories: entry.categories,
              summary: entry.summary.substring(0, 200) + '...',
              pdfUrl: entry.links.find(l => l.type === 'application/pdf')?.href,
            })),
          }, null, 2),
        },
      ],
    };
  }

  private async getPaperById(args: any) {
    await this.enforceRateLimit();

    const ids = args.ids.join(',');
    const params = new URLSearchParams({
      id_list: ids,
    });

    const response = await axios.get(`${ARXIV_API_BASE}?${params}`);
    const parsed = await parseStringPromise(response.data);
    const result = this.parseArxivResponse(parsed);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            papers: result.entries.map(entry => ({
              id: entry.id.split('/').pop(),
              title: entry.title,
              authors: entry.authors,
              published: entry.published,
              updated: entry.updated,
              categories: entry.categories,
              primaryCategory: entry.primaryCategory,
              summary: entry.summary,
              comment: entry.comment,
              journalRef: entry.journalRef,
              doi: entry.doi,
              links: entry.links,
            })),
          }, null, 2),
        },
      ],
    };
  }

  private async getRecentPapers(args: any) {
    await this.enforceRateLimit();

    const params = new URLSearchParams({
      search_query: `cat:${args.category}`,
      max_results: String(args.maxResults || 10),
      sortBy: 'submittedDate',
      sortOrder: 'descending',
    });

    const response = await axios.get(`${ARXIV_API_BASE}?${params}`);
    const parsed = await parseStringPromise(response.data);
    const result = this.parseArxivResponse(parsed);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            category: args.category,
            totalPapers: result.totalResults,
            recentPapers: result.entries.map(entry => ({
              id: entry.id.split('/').pop(),
              title: entry.title,
              authors: entry.authors.map(a => a.name).join(', '),
              submitted: entry.published.split('T')[0],
              summary: entry.summary.substring(0, 200) + '...',
              pdfUrl: entry.links.find(l => l.type === 'application/pdf')?.href,
            })),
          }, null, 2),
        },
      ],
    };
  }

  private async searchAuthor(args: any) {
    await this.enforceRateLimit();

    const params = new URLSearchParams({
      search_query: `au:"${args.author}"`,
      max_results: String(args.maxResults || 20),
      sortBy: args.sortBy || 'submittedDate',
      sortOrder: 'descending',
    });

    const response = await axios.get(`${ARXIV_API_BASE}?${params}`);
    const parsed = await parseStringPromise(response.data);
    const result = this.parseArxivResponse(parsed);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            author: args.author,
            totalPapers: result.totalResults,
            papers: result.entries.map(entry => ({
              id: entry.id.split('/').pop(),
              title: entry.title,
              allAuthors: entry.authors.map(a => a.name).join(', '),
              published: entry.published.split('T')[0],
              categories: entry.categories,
              pdfUrl: entry.links.find(l => l.type === 'application/pdf')?.href,
            })),
          }, null, 2),
        },
      ],
    };
  }

  private async downloadPaper(args: any) {
    if (!args.arxivId) {
      throw new ValidationError('arxivId is required');
    }

    // First get the paper details
    const paperResult = await this.getPaperById({ ids: [args.arxivId] });
    const papers = JSON.parse(paperResult.content[0].text).papers;
    
    if (papers.length === 0) {
      throw new ValidationError(`Paper with ID ${args.arxivId} not found`);
    }

    const paper = papers[0];
    const pdfLink = paper.links.find((l: any) => l.type === 'application/pdf');
    
    if (!pdfLink) {
      throw new ValidationError(`No PDF link found for paper ${args.arxivId}`);
    }

    const downloadedPaper = await storageManager.downloadPaper(
      args.arxivId,
      pdfLink.href,
      {
        title: paper.title,
        authors: paper.authors.map((a: any) => a.name),
        categories: paper.categories,
        abstract: paper.summary
      }
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            message: 'Paper downloaded successfully',
            paper: downloadedPaper
          }, null, 2),
        },
      ],
    };
  }

  private async listDownloadedPapers() {
    const papers = await storageManager.listDownloadedPapers();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            totalPapers: papers.length,
            papers: papers.map(p => ({
              id: p.id,
              title: p.title,
              authors: p.authors,
              downloadDate: p.downloadDate,
              fileSize: p.fileSize,
              categories: p.categories
            }))
          }, null, 2),
        },
      ],
    };
  }

  private async deletePaper(args: any) {
    if (!args.arxivId) {
      throw new ValidationError('arxivId is required');
    }

    const deleted = await storageManager.deletePaper(args.arxivId);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: deleted,
            message: deleted ? `Paper ${args.arxivId} deleted successfully` : `Paper ${args.arxivId} not found`
          }, null, 2),
        },
      ],
    };
  }

  private async getStorageStats() {
    const stats = await storageManager.getStorageStats();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }

  private async readPaperContent(args: any) {
    if (!args.arxivId) {
      throw new ValidationError('arxivId is required');
    }

    const papers = await storageManager.listDownloadedPapers();
    const paper = papers.find(p => p.id === args.arxivId);
    
    if (!paper) {
      throw new ValidationError(`Paper ${args.arxivId} not found in local storage. Please download it first.`);
    }

    const content = await pdfReader.readPaperContent(paper.filePath, paper.id, paper.title);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: content.id,
            title: content.title,
            sections: content.sections,
            fullTextLength: content.fullText.length
          }, null, 2),
        },
      ],
    };
  }

  private async searchInPaper(args: any) {
    if (!args.arxivId || !args.searchTerm) {
      throw new ValidationError('arxivId and searchTerm are required');
    }

    const papers = await storageManager.listDownloadedPapers();
    const paper = papers.find(p => p.id === args.arxivId);
    
    if (!paper) {
      throw new ValidationError(`Paper ${args.arxivId} not found in local storage. Please download it first.`);
    }

    const content = await pdfReader.readPaperContent(paper.filePath, paper.id, paper.title);
    const searchResults = pdfReader.searchInPaper(content, args.searchTerm, args.caseSensitive || false);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            paperId: args.arxivId,
            searchTerm: args.searchTerm,
            totalMatches: searchResults.reduce((sum, r) => sum + r.matches.length, 0),
            results: searchResults
          }, null, 2),
        },
      ],
    };
  }

  private async getAnalysisPrompts() {
    const prompts = promptManager.getAllPrompts();
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            totalPrompts: prompts.length,
            prompts: prompts.map(p => ({
              id: p.id,
              name: p.name,
              description: p.description,
              variables: p.variables
            }))
          }, null, 2),
        },
      ],
    };
  }

  private async analyzePaper(args: any) {
    if (!args.arxivId || !args.promptId) {
      throw new ValidationError('arxivId and promptId are required');
    }

    // Get paper details
    const paperResult = await this.getPaperById({ ids: [args.arxivId] });
    const papers = JSON.parse(paperResult.content[0].text).papers;
    
    if (papers.length === 0) {
      throw new ValidationError(`Paper with ID ${args.arxivId} not found`);
    }

    const paper = papers[0];
    const prompt = promptManager.getPrompt(args.promptId);
    
    if (!prompt) {
      throw new ValidationError(`Prompt with ID ${args.promptId} not found`);
    }

    // Prepare variables for the prompt
    const variables: Record<string, string> = {
      title: paper.title,
      authors: paper.authors.map((a: any) => a.name).join(', '),
      abstract: paper.summary,
      categories: paper.categories.join(', '),
      year: new Date(paper.published).getFullYear().toString()
    };

    const filledPrompt = promptManager.applyPromptTemplate(prompt, variables);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            paperId: args.arxivId,
            promptId: args.promptId,
            promptName: prompt.name,
            filledPrompt: filledPrompt
          }, null, 2),
        },
      ],
    };
  }

  private async getArxivCategories(args: any) {
    try {
      // Get the directory name for resolving the JSON file path
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      
      // Read the category data from file
      const categoryFilePath = join(__dirname, '../prompts/arxiv_categories.json');
      const categoryData = await readJsonFile<ArxivCategories>(categoryFilePath);
      
      if (!categoryData) {
        throw new NetworkError('Failed to read category data');
      }
      
      const categories = categoryData.categories;

      // If no group specified, return all group names
      if (!args.group) {
        const groupNames = categories.map((categoryGroup) => ({
          group: categoryGroup.group
        }));
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                totalGroups: groupNames.length,
                groups: groupNames
              }, null, 2),
            },
          ],
        };
      }

      // If group specified, return detailed information for that group
      const group = categories.find((categoryGroup) => 
        categoryGroup.group.toLowerCase() === args.group.toLowerCase()
      );

      if (!group) {
        throw new ValidationError(`Group '${args.group}' not found`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              group: group.group,
              totalCategories: group.categories.length,
              categories: group.categories.map((category) => ({
                id: category.id,
                name: category.name,
                description: category.description
              }))
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Error reading category data:', error);
      throw new NetworkError('Failed to read category data');
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('arXiv MCP server running on stdio');
  }
}

const server = new ArxivServer();
server.run().catch(console.error);
