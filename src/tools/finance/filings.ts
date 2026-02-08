import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callApi } from './api.js';
import { formatToolResult } from '../types.js';

// Types for filing item metadata
export interface FilingItemType {
  name: string;  // e.g., "Item-1", "Part-1,Item-2"
  title: string; // e.g., "Business", "MD&A"
}

export interface FilingItemTypes {
  '10-K': FilingItemType[];
  '10-Q': FilingItemType[];
}

/**
 * Standard SEC filing item types.
 * These are defined by SEC regulation and rarely change,
 * so a static fallback is reliable when the API is unavailable.
 */
const FALLBACK_ITEM_TYPES: FilingItemTypes = {
  '10-K': [
    { name: 'Item-1', title: 'Business' },
    { name: 'Item-1A', title: 'Risk Factors' },
    { name: 'Item-1B', title: 'Unresolved Staff Comments' },
    { name: 'Item-1C', title: 'Cybersecurity' },
    { name: 'Item-2', title: 'Properties' },
    { name: 'Item-3', title: 'Legal Proceedings' },
    { name: 'Item-4', title: 'Mine Safety Disclosures' },
    { name: 'Item-5', title: 'Market for Common Equity' },
    { name: 'Item-6', title: 'Reserved' },
    { name: 'Item-7', title: "Management's Discussion and Analysis (MD&A)" },
    { name: 'Item-7A', title: 'Quantitative and Qualitative Disclosures About Market Risk' },
    { name: 'Item-8', title: 'Financial Statements and Supplementary Data' },
    { name: 'Item-9', title: 'Changes in and Disagreements with Accountants' },
    { name: 'Item-9A', title: 'Controls and Procedures' },
    { name: 'Item-9B', title: 'Other Information' },
    { name: 'Item-10', title: 'Directors and Corporate Governance' },
    { name: 'Item-11', title: 'Executive Compensation' },
    { name: 'Item-12', title: 'Security Ownership' },
    { name: 'Item-13', title: 'Certain Relationships and Related Transactions' },
    { name: 'Item-14', title: 'Principal Accountant Fees and Services' },
    { name: 'Item-15', title: 'Exhibits and Financial Statement Schedules' },
  ],
  '10-Q': [
    { name: 'Part-1,Item-1', title: 'Financial Statements' },
    { name: 'Part-1,Item-2', title: "Management's Discussion and Analysis (MD&A)" },
    { name: 'Part-1,Item-3', title: 'Quantitative and Qualitative Disclosures About Market Risk' },
    { name: 'Part-1,Item-4', title: 'Controls and Procedures' },
    { name: 'Part-2,Item-1', title: 'Legal Proceedings' },
    { name: 'Part-2,Item-1A', title: 'Risk Factors' },
    { name: 'Part-2,Item-2', title: 'Unregistered Sales of Equity Securities' },
    { name: 'Part-2,Item-3', title: 'Defaults Upon Senior Securities' },
    { name: 'Part-2,Item-4', title: 'Mine Safety Disclosures' },
    { name: 'Part-2,Item-5', title: 'Other Information' },
    { name: 'Part-2,Item-6', title: 'Exhibits' },
  ],
};

/**
 * Fetches canonical item type names from the API.
 * Falls back to static definitions when the API is unavailable
 * (e.g. FMP-only users without a Financial Datasets key).
 */
export async function getFilingItemTypes(): Promise<FilingItemTypes> {
  try {
    const response = await fetch('https://api.financialdatasets.ai/filings/items/types/');
    if (!response.ok) {
      return FALLBACK_ITEM_TYPES;
    }
    return await response.json();
  } catch {
    return FALLBACK_ITEM_TYPES;
  }
}

const FilingsInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch filings for. For example, 'AAPL' for Apple."),
  filing_type: z
    .enum(['10-K', '10-Q', '8-K'])
    .optional()
    .describe(
      "REQUIRED when searching for a specific filing type. Use '10-K' for annual reports, '10-Q' for quarterly reports, or '8-K' for current reports. If omitted, returns most recent filings of ANY type."
    ),
  limit: z
    .number()
    .default(10)
    .describe(
      'Maximum number of filings to return (default: 10). Returns the most recent N filings matching the criteria.'
    ),
});

export const getFilings = new DynamicStructuredTool({
  name: 'get_filings',
  description: `Retrieves metadata for SEC filings for a company. Returns accession numbers, filing types, and document URLs. This tool ONLY returns metadata - it does NOT return the actual text content from filings. To retrieve text content, use the specific filing items tools: get_10K_filing_items, get_10Q_filing_items, or get_8K_filing_items.`,
  schema: FilingsInputSchema,
  func: async (input) => {
    const params: Record<string, string | number | undefined> = {
      ticker: input.ticker,
      limit: input.limit,
      filing_type: input.filing_type,
    };
    const { data, url } = await callApi('/filings/', params);
    return formatToolResult(data.filings || [], [url]);
  },
});

const Filing10KItemsInputSchema = z.object({
  ticker: z.string().describe("The stock ticker symbol. For example, 'AAPL' for Apple."),
  accession_number: z
    .string()
    .describe(
      "The SEC accession number for the 10-K filing. For example, '0000320193-24-000123'. Can be retrieved from the get_filings tool."
    ),
  items: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of specific item names to retrieve. If omitted, returns all items. Use exact item names from the provided list (e.g., 'Item-1', 'Item-1A', 'Item-7')."
    ),
});

export const get10KFilingItems = new DynamicStructuredTool({
  name: 'get_10K_filing_items',
  description: `Retrieves sections (items) from a company's 10-K annual report. Specify items to retrieve only specific sections, or omit to get all. Common items: Item-1 (Business), Item-1A (Risk Factors), Item-7 (MD&A), Item-8 (Financial Statements). The accession_number can be retrieved using the get_filings tool.`,
  schema: Filing10KItemsInputSchema,
  func: async (input) => {
    const params: Record<string, string | string[] | undefined> = {
      ticker: input.ticker.toUpperCase(),
      filing_type: '10-K',
      accession_number: input.accession_number,
      item: input.items, // API expects 'item' not 'items'
    };
    // SEC filings are legally immutable once filed
    const { data, url } = await callApi('/filings/items/', params, { cacheable: true });
    return formatToolResult(data, [url]);
  },
});

const Filing10QItemsInputSchema = z.object({
  ticker: z.string().describe("The stock ticker symbol. For example, 'AAPL' for Apple."),
  accession_number: z
    .string()
    .describe(
      "The SEC accession number for the 10-Q filing. For example, '0000320193-24-000123'. Can be retrieved from the get_filings tool."
    ),
  items: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of specific item names to retrieve. If omitted, returns all items. Use exact item names from the provided list (e.g., 'Part-1,Item-1', 'Part-1,Item-2')."
    ),
});

export const get10QFilingItems = new DynamicStructuredTool({
  name: 'get_10Q_filing_items',
  description: `Retrieves sections (items) from a company's 10-Q quarterly report. Specify items to retrieve only specific sections, or omit to get all. Common items: Part-1,Item-1 (Financial Statements), Part-1,Item-2 (MD&A), Part-1,Item-3 (Market Risk), Part-2,Item-1A (Risk Factors). The accession_number can be retrieved using the get_filings tool.`,
  schema: Filing10QItemsInputSchema,
  func: async (input) => {
    const params: Record<string, string | string[] | undefined> = {
      ticker: input.ticker.toUpperCase(),
      filing_type: '10-Q',
      accession_number: input.accession_number,
      item: input.items, // API expects 'item' not 'items'
    };
    // SEC filings are legally immutable once filed
    const { data, url } = await callApi('/filings/items/', params, { cacheable: true });
    return formatToolResult(data, [url]);
  },
});

const Filing8KItemsInputSchema = z.object({
  ticker: z.string().describe("The stock ticker symbol. For example, 'AAPL' for Apple."),
  accession_number: z
    .string()
    .describe(
      "The SEC accession number for the 8-K filing. For example, '0000320193-24-000123'. This can be retrieved from the get_filings tool."
    ),
});

export const get8KFilingItems = new DynamicStructuredTool({
  name: 'get_8K_filing_items',
  description: `Retrieves specific sections (items) from a company's 8-K current report. 8-K filings report material events such as acquisitions, financial results, management changes, and other significant corporate events. The accession_number parameter can be retrieved using the get_filings tool by filtering for 8-K filings.`,
  schema: Filing8KItemsInputSchema,
  func: async (input) => {
    const params: Record<string, string | undefined> = {
      ticker: input.ticker.toUpperCase(),
      filing_type: '8-K',
      accession_number: input.accession_number,
    };
    // SEC filings are legally immutable once filed
    const { data, url } = await callApi('/filings/items/', params, { cacheable: true });
    return formatToolResult(data, [url]);
  },
});

