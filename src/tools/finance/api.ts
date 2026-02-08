import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const BASE_URL = 'https://api.financialdatasets.ai';
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

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

    let fmpEndpoint = '';
    let resultKey = '';
    let isAggregated = false;

    if (endpoint.includes('income-statements')) {
      fmpEndpoint = `/income-statement/${ticker}`;
      resultKey = 'income_statements';
    } else if (endpoint.includes('balance-sheets')) {
      fmpEndpoint = `/balance-sheet-statement/${ticker}`;
      resultKey = 'balance_sheets';
    } else if (endpoint.includes('cash-flow-statements')) {
      fmpEndpoint = `/cash-flow-statement/${ticker}`;
      resultKey = 'cash_flow_statements';
    } else if (endpoint === '/financials/') {
      isAggregated = true;
    } else if (endpoint.includes('/financial-metrics/snapshot/')) {
        fmpEndpoint = `/ratios-ttm/${ticker}`;
        resultKey = 'snapshot';
    } else if (endpoint.includes('/financial-metrics/')) {
        fmpEndpoint = `/ratios/${ticker}`;
        resultKey = 'financial_metrics';
    } else {
      throw new Error(`Endpoint ${endpoint} not supported by FMP adapter yet`);
    }

    // Helper to fetch FMP
    const fetchFMP = async (subEndpoint: string, subKey: string) => {
        const url = new URL(`${FMP_BASE_URL}${subEndpoint}`);
        url.searchParams.append('apikey', FMP_API_KEY);
        if (params.limit) url.searchParams.append('limit', String(params.limit));
        if (params.period === 'quarterly') url.searchParams.append('period', 'quarter');
        // FMP doesn't support other filters (dates) easily in this endpoint style without bulk, ignoring for now.

        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`FMP API request failed: ${res.status}`);
        const data = await res.json();
        return { [subKey]: data };
    };

    if (isAggregated) {
       // Parallel fetch for aggregated
       const [income, balance, cash] = await Promise.all([
           fetchFMP(`/income-statement/${ticker}`, 'income_statements'),
           fetchFMP(`/balance-sheet-statement/${ticker}`, 'balance_sheets'),
           fetchFMP(`/cash-flow-statement/${ticker}`, 'cash_flow_statements')
       ]);

       const data = { financials: { ...income, ...balance, ...cash } };
       const url = 'https://financialmodelingprep.com/api/v3/(aggregated)';
       if (options?.cacheable) {
         writeCache(endpoint, params, data, url);
       }
       return { data, url };
    } else {
       const result = await fetchFMP(fmpEndpoint, resultKey);
       const url = `${FMP_BASE_URL}${fmpEndpoint}`;
       if (options?.cacheable) {
         writeCache(endpoint, params, result, url);
       }
       return { data: result, url };
    }

  } else {
    throw new Error('No valid financial API key found (requires FINANCIAL_DATASETS_API_KEY or FMP_API_KEY)');
  }
}
