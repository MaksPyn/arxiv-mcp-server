export interface ArxivEntry {
  id: string;
  updated: string;
  published: string;
  title: string;
  summary: string;
  authors: Array<{ name: string; affiliation?: string }>;
  categories: string[];
  primaryCategory: string;
  links: Array<{ href: string; type?: string; title?: string }>;
  comment?: string;
  journalRef?: string;
  doi?: string;
}

export interface SearchResult {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  entries: ArxivEntry[];
}

export interface DownloadedPaper {
  id: string;
  title: string;
  authors: string[];
  downloadDate: string;
  filePath: string;
  fileSize: number;
  categories: string[];
  abstract: string;
}

export interface AnalysisPrompt {
  id: string;
  name: string;
  description: string;
  template: string;
  variables: string[];
}

export interface PaperContent {
  id: string;
  title: string;
  sections: {
    abstract?: string;
    introduction?: string;
    methodology?: string;
    results?: string;
    discussion?: string;
    conclusion?: string;
    references?: string;
    [key: string]: string | undefined;
  };
  fullText: string;
}

export interface ArxivCategory {
  id: string;
  name: string;
  description: string;
}

export interface ArxivCategoryGroup {
  group: string;
  categories: ArxivCategory[];
}

export interface ArxivCategories {
  categories: ArxivCategoryGroup[];
}
