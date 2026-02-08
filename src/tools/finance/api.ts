import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const BASE_URL = 'https://api.financialdatasets.ai';
const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

export interface ApiResponse {
  data: Record<string, unknown>;
  url: string;
}

export async function callApi(
  endpoint: string,
  params: Record<string, string | number | string[] | undefined>,
  options?: { cacheable?: boolean }
): Promise<ApiResponse> {
  const label = describeRequest(endpoint, params);

  // Check local cache first — avoids redundant network calls for immutable data
  if (options?.cacheable) {
    const cached = readCache(endpoint, params);
    if (cached) {
      return cached;
    }
  }

  // Read API key lazily at call time (after dotenv has loaded)
  const FINANCIAL_DATASETS_API_KEY = process.env.FINANCIAL_DATASETS_API_KEY;
  const FMP_API_KEY = process.env.FMP_API_KEY;

  // 1. Use Financial Datasets if key exists
  if (FINANCIAL_DATASETS_API_KEY) {
    const url = new URL(`${BASE_URL}${endpoint}`);

    // Add params to URL, handling arrays
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: {
          'x-api-key': FINANCIAL_DATASETS_API_KEY,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`API network error: ${label} — ${message}`);
      throw new Error(`API request failed for ${label}: ${message}`);
    }

    if (!response.ok) {
      const detail = `${response.status} ${response.statusText}`;
      logger.error(`API error: ${label} — ${detail}`);
      throw new Error(`API request failed: ${detail}`);
    }

    const data = await response.json().catch(() => {
      const detail = `invalid JSON (${response.status} ${response.statusText})`;
      logger.error(`API parse error: ${label} — ${detail}`);
      throw new Error(`API request failed: ${detail}`);
    });

    // Persist for future requests when the caller marked the response as cacheable
    if (options?.cacheable) {
      writeCache(endpoint, params, data, url.toString());
    }

    return { data, url: url.toString() };
  }

  // 2. Use FMP if key exists
  else if (FMP_API_KEY) {
    const ticker = params.ticker as string;
    if (!ticker) throw new Error('Ticker is required for FMP API');

    // Helper: build FMP URL, fetch, and return { [subKey]: data }
    // The stable API uses query params (?symbol=AAPL) instead of path params (/AAPL)
    const fetchFMP = async (
      subEndpoint: string,
      subKey: string,
      extraParams?: Record<string, string>,
      opts?: { skipSymbol?: boolean }
    ) => {
        const url = new URL(`${FMP_BASE_URL}${subEndpoint}`);
        if (!opts?.skipSymbol) url.searchParams.append('symbol', ticker);
        url.searchParams.append('apikey', FMP_API_KEY);
        if (params.limit) url.searchParams.append('limit', String(params.limit));
        if (params.period === 'quarterly') url.searchParams.append('period', 'quarter');
        if (extraParams) {
          for (const [k, v] of Object.entries(extraParams)) {
            url.searchParams.append(k, v);
          }
        }
        const res = await fetch(url.toString());
        if (!res.ok) {
          logger.error(`FMP API error: ${label} — ${res.status}`);
          throw new Error(`FMP API request failed: ${res.status}`);
        }
        const data = await res.json();
        return { data: { [subKey]: data }, url: url.toString() };
    };

    // Helper: cache + return
    const returnFMP = (result: { data: Record<string, unknown>; url: string }) => {
      if (options?.cacheable) {
        writeCache(endpoint, params, result.data, result.url);
      }
      return result;
    };

    // --- Financial Statements ---
    if (endpoint.includes('income-statements')) {
      return returnFMP(await fetchFMP('/income-statement', 'income_statements'));
    }
    if (endpoint.includes('balance-sheets')) {
      return returnFMP(await fetchFMP('/balance-sheet-statement', 'balance_sheets'));
    }
    if (endpoint.includes('cash-flow-statements')) {
      return returnFMP(await fetchFMP('/cash-flow-statement', 'cash_flow_statements'));
    }
    if (endpoint.includes('/segmented-revenues/')) {
      return returnFMP(await fetchFMP('/revenue-product-segmentation', 'segmented_revenues'));
    }
    if (endpoint === '/financials/') {
      // Aggregated: parallel fetch all 3 statements
      const [income, balance, cash] = await Promise.all([
        fetchFMP('/income-statement', 'income_statements'),
        fetchFMP('/balance-sheet-statement', 'balance_sheets'),
        fetchFMP('/cash-flow-statement', 'cash_flow_statements'),
      ]);
      const data = { financials: { ...income.data, ...balance.data, ...cash.data } };
      const url = `${FMP_BASE_URL}/(aggregated)`;
      if (options?.cacheable) writeCache(endpoint, params, data, url);
      return { data, url };
    }

    // --- Financial Metrics ---
    // NOTE: snapshot must be checked before the general /financial-metrics/ match
    if (endpoint.includes('/financial-metrics/snapshot/')) {
      return returnFMP(await fetchFMP('/ratios-ttm', 'snapshot'));
    }
    if (endpoint.includes('/financial-metrics/')) {
      return returnFMP(await fetchFMP('/ratios', 'financial_metrics'));
    }

    // --- Stock Prices ---
    if (endpoint.includes('/prices/snapshot')) {
      const result = await fetchFMP('/quote', 'snapshot');
      // FMP returns array; extract first element
      const arr = result.data.snapshot;
      result.data = { snapshot: Array.isArray(arr) ? arr[0] : arr };
      return returnFMP(result);
    }
    if (endpoint === '/prices/') {
      const extra: Record<string, string> = {};
      if (params.start_date) extra.from = String(params.start_date);
      if (params.end_date) extra.to = String(params.end_date);
      const result = await fetchFMP('/historical-price-eod/full', 'prices', extra);
      // FMP returns { symbol, historical: [...] }; extract the array
      const raw = result.data.prices as Record<string, unknown>;
      result.data = { prices: (raw && typeof raw === 'object' && 'historical' in raw) ? raw.historical : raw };
      return returnFMP(result);
    }

    // --- Company Info ---
    if (endpoint === '/company/facts') {
      const result = await fetchFMP('/profile', 'company_facts');
      // FMP returns array; extract first element
      const arr = result.data.company_facts;
      result.data = { company_facts: Array.isArray(arr) ? arr[0] : arr };
      return returnFMP(result);
    }

    // --- Analyst Estimates ---
    if (endpoint.includes('/analyst-estimates/')) {
      return returnFMP(await fetchFMP('/analyst-estimates', 'analyst_estimates'));
    }

    // --- Insider Trades ---
    if (endpoint.includes('/insider-trades/')) {
      return returnFMP(await fetchFMP('/insider-trading/search', 'insider_trades'));
    }

    // --- News ---
    if (endpoint === '/news/') {
      const extra: Record<string, string> = { symbols: ticker };
      if (params.start_date) extra.from = String(params.start_date);
      if (params.end_date) extra.to = String(params.end_date);
      return returnFMP(await fetchFMP('/news/stock', 'news', extra, { skipSymbol: true }));
    }

    // --- SEC Filings (metadata only) ---
    if (endpoint === '/filings/') {
      const extra: Record<string, string> = {};
      if (params.filing_type) extra.type = String(params.filing_type);
      return returnFMP(await fetchFMP('/sec-filings-search/symbol', 'filings', extra));
    }

    // --- Not supported ---
    throw new Error(`Endpoint ${endpoint} not supported by FMP adapter yet`);

  } else {
    throw new Error('No valid financial API key found (requires FINANCIAL_DATASETS_API_KEY or FMP_API_KEY)');
  }
}
