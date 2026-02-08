import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { callApi } from './api.js';

const TEST_CACHE_DIR = '.dexter/cache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock Response matching the fetch API shape. */
function mockResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => data,
  } as Response;
}

// ---------------------------------------------------------------------------
// FMP adapter tests
// ---------------------------------------------------------------------------

describe('callApi — FMP adapter', () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Clear any cached files
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    // Set FMP key only (no Financial Datasets key)
    delete process.env.FINANCIAL_DATASETS_API_KEY;
    process.env.FMP_API_KEY = 'test-fmp-key';

    // Mock global fetch
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    // Clean cache
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Endpoint mapping
  // -------------------------------------------------------------------------

  test('maps income-statements endpoint', async () => {
    const fmpData = [{ date: '2024-12-31', revenue: 100000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 });

    expect(result.data).toEqual({ income_statements: fmpData });
    expect(result.url).toContain('/stable/income-statement');
    expect(result.url).toContain('symbol=AAPL');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('maps balance-sheets endpoint', async () => {
    const fmpData = [{ date: '2024-12-31', totalAssets: 500000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financials/balance-sheets/', { ticker: 'AAPL', period: 'annual', limit: 1 });

    expect(result.data).toEqual({ balance_sheets: fmpData });
    expect(result.url).toContain('/stable/balance-sheet-statement');
    expect(result.url).toContain('symbol=AAPL');
  });

  test('maps cash-flow-statements endpoint', async () => {
    const fmpData = [{ date: '2024-12-31', operatingCashFlow: 80000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financials/cash-flow-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 });

    expect(result.data).toEqual({ cash_flow_statements: fmpData });
    expect(result.url).toContain('/stable/cash-flow-statement');
    expect(result.url).toContain('symbol=AAPL');
  });

  test('maps financial-metrics endpoint (historical ratios)', async () => {
    const fmpData = [{ date: '2024-12-31', peRatio: 25.5 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financial-metrics/', { ticker: 'AAPL', period: 'annual', limit: 4 });

    expect(result.data).toEqual({ financial_metrics: fmpData });
    expect(result.url).toContain('/stable/ratios');
    expect(result.url).toContain('symbol=AAPL');
  });

  test('maps financial-metrics/snapshot endpoint (TTM ratios)', async () => {
    const fmpData = [{ peRatioTTM: 28.3 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financial-metrics/snapshot/', { ticker: 'AAPL' });

    expect(result.data).toEqual({ snapshot: fmpData[0] });
    expect(result.url).toContain('/stable/ratios-ttm');
    expect(result.url).toContain('symbol=AAPL');
  });

  // -------------------------------------------------------------------------
  // Aggregated financials
  // -------------------------------------------------------------------------

  test('fetches all 3 statements in parallel for /financials/ endpoint', async () => {
    const income = [{ revenue: 100000 }];
    const balance = [{ totalAssets: 500000 }];
    const cash = [{ operatingCashFlow: 80000 }];

    fetchSpy
      .mockResolvedValueOnce(mockResponse(income))
      .mockResolvedValueOnce(mockResponse(balance))
      .mockResolvedValueOnce(mockResponse(cash));

    const result = await callApi('/financials/', { ticker: 'AAPL', period: 'annual', limit: 1 });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.data.financials).toEqual({
      income_statements: income,
      balance_sheets: balance,
      cash_flow_statements: cash,
    });
  });

  // -------------------------------------------------------------------------
  // New endpoint mappings
  // -------------------------------------------------------------------------

  test('maps prices/snapshot endpoint (extracts first element)', async () => {
    const fmpData = [{ symbol: 'AAPL', price: 185.5, volume: 50000000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/prices/snapshot/', { ticker: 'AAPL' });

    expect(result.data).toEqual({ snapshot: fmpData[0] });
    expect(result.url).toContain('/stable/quote');
    expect(result.url).toContain('symbol=AAPL');
  });

  test('maps prices endpoint (extracts historical array)', async () => {
    const fmpData = { symbol: 'AAPL', historical: [{ date: '2024-12-31', close: 185.5 }] };
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/prices/', { ticker: 'AAPL', start_date: '2024-01-01', end_date: '2024-12-31' });

    expect(result.data).toEqual({ prices: fmpData.historical });
    expect(result.url).toContain('/stable/historical-price-eod/full');
    expect(result.url).toContain('symbol=AAPL');
    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('from=2024-01-01');
    expect(calledUrl).toContain('to=2024-12-31');
  });

  test('maps company/facts endpoint (extracts first element)', async () => {
    const fmpData = [{ symbol: 'AAPL', companyName: 'Apple Inc.', sector: 'Technology' }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/company/facts', { ticker: 'AAPL' });

    expect(result.data).toEqual({ company_facts: fmpData[0] });
    expect(result.url).toContain('/stable/profile');
    expect(result.url).toContain('symbol=AAPL');
  });

  test('maps analyst-estimates endpoint', async () => {
    const fmpData = [{ date: '2025-12-31', estimatedRevenueAvg: 400000000000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/analyst-estimates/', { ticker: 'AAPL', period: 'annual' });

    expect(result.data).toEqual({ analyst_estimates: fmpData });
    expect(result.url).toContain('/stable/analyst-estimates');
    expect(result.url).toContain('symbol=AAPL');
  });

  test('maps insider-trades endpoint (uses symbol query param)', async () => {
    const fmpData = [{ symbol: 'AAPL', transactionDate: '2024-12-15', transactionType: 'S-Sale' }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/insider-trades/', { ticker: 'AAPL', limit: 50 });

    expect(result.data).toEqual({ insider_trades: fmpData });
    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('/insider-trading/search');
    expect(calledUrl).toContain('symbol=AAPL');
  });

  test('maps news endpoint (uses symbols query param)', async () => {
    const fmpData = [{ title: 'Apple Q4 Earnings', publishedDate: '2024-12-20' }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/news/', { ticker: 'AAPL', limit: 10 });

    expect(result.data).toEqual({ news: fmpData });
    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('/news/stock');
    expect(calledUrl).toContain('symbols=AAPL');
  });

  test('forwards date params for news endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse([]));

    await callApi('/news/', { ticker: 'AAPL', limit: 10, start_date: '2024-01-01', end_date: '2024-12-31' });

    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('from=2024-01-01');
    expect(calledUrl).toContain('to=2024-12-31');
  });

  test('maps filings endpoint with required from/to dates', async () => {
    const fmpData = [
      { symbol: 'AAPL', type: '10-K', fillingDate: '2024-11-01' },
      { symbol: 'AAPL', type: '8-K', fillingDate: '2024-10-15' },
    ];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/filings/', { ticker: 'AAPL', limit: 5 });

    expect(result.data).toEqual({ filings: fmpData });
    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('/sec-filings-search/symbol');
    expect(calledUrl).toContain('symbol=AAPL');
    expect(calledUrl).toContain('from=');
    expect(calledUrl).toContain('to=');
    // type is NOT sent as query param (stable API doesn't support it)
    expect(calledUrl).not.toContain('type=');
  });

  test('filters filings by type client-side when filing_type is specified', async () => {
    const fmpData = [
      { symbol: 'AAPL', type: '10-K', fillingDate: '2024-11-01' },
      { symbol: 'AAPL', type: '8-K', fillingDate: '2024-10-15' },
      { symbol: 'AAPL', type: '10-Q', fillingDate: '2024-08-01' },
    ];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/filings/', { ticker: 'AAPL', filing_type: '10-K', limit: 5 });

    // Only 10-K should remain after client-side filter
    expect(result.data).toEqual({
      filings: [{ symbol: 'AAPL', type: '10-K', fillingDate: '2024-11-01' }],
    });
  });

  test('maps segmented-revenues endpoint', async () => {
    const fmpData = [{ date: '2024-12-31', iphoneRevenue: 200000000000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financials/segmented-revenues/', { ticker: 'AAPL', period: 'annual', limit: 5 });

    expect(result.data).toEqual({ segmented_revenues: fmpData });
    expect(result.url).toContain('/stable/revenue-product-segmentation');
    expect(result.url).toContain('symbol=AAPL');
  });

  // -------------------------------------------------------------------------
  // Unsupported endpoint
  // -------------------------------------------------------------------------

  test('throws descriptive error for filings/items (requires Financial Datasets key)', async () => {
    await expect(
      callApi('/filings/items/', { ticker: 'AAPL' })
    ).rejects.toThrow('requires a Financial Datasets API key');
  });

  test('throws for unsupported endpoints', async () => {
    await expect(
      callApi('/some/unsupported/endpoint/', { ticker: 'AAPL' })
    ).rejects.toThrow('not supported by FMP adapter');
  });

  // -------------------------------------------------------------------------
  // Ticker required
  // -------------------------------------------------------------------------

  test('throws when ticker is missing', async () => {
    await expect(
      callApi('/financials/income-statements/', { period: 'annual', limit: 1 })
    ).rejects.toThrow('Ticker is required');
  });

  // -------------------------------------------------------------------------
  // Cache integration
  // -------------------------------------------------------------------------

  test('writes to cache when cacheable is true', async () => {
    const fmpData = [{ date: '2024-12-31', revenue: 100000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    await callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 }, { cacheable: true });

    // Second call should hit cache, not fetch
    const result = await callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 }, { cacheable: true });

    expect(fetchSpy).toHaveBeenCalledTimes(1); // Only first call fetches
    expect(result.data).toEqual({ income_statements: fmpData });
  });

  test('writes aggregated response to cache when cacheable is true', async () => {
    const income = [{ revenue: 100000 }];
    const balance = [{ totalAssets: 500000 }];
    const cash = [{ operatingCashFlow: 80000 }];

    fetchSpy
      .mockResolvedValueOnce(mockResponse(income))
      .mockResolvedValueOnce(mockResponse(balance))
      .mockResolvedValueOnce(mockResponse(cash));

    await callApi('/financials/', { ticker: 'AAPL', period: 'annual', limit: 1 }, { cacheable: true });

    // Second call should hit cache
    const result = await callApi('/financials/', { ticker: 'AAPL', period: 'annual', limit: 1 }, { cacheable: true });

    expect(fetchSpy).toHaveBeenCalledTimes(3); // Only first call's 3 fetches
    expect(result.data.financials).toEqual({
      income_statements: income,
      balance_sheets: balance,
      cash_flow_statements: cash,
    });
  });

  test('does not write cache when cacheable is not set', async () => {
    const fmpData = [{ date: '2024-12-31', revenue: 100000 }];
    fetchSpy.mockResolvedValue(mockResponse(fmpData));

    await callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 });
    await callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 });

    // Both calls should fetch (no caching)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // FMP fetch error
  // -------------------------------------------------------------------------

  test('throws on FMP API error response', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(null, false, 401));

    await expect(
      callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 })
    ).rejects.toThrow('FMP API request failed: 401');
  });

  // -------------------------------------------------------------------------
  // Query parameter forwarding
  // -------------------------------------------------------------------------

  test('forwards limit and quarterly period to FMP URL', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse([]));

    await callApi('/financials/income-statements/', { ticker: 'MSFT', period: 'quarterly', limit: 4 });

    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain('symbol=MSFT');
    expect(calledUrl).toContain('limit=4');
    expect(calledUrl).toContain('period=quarter');
    expect(calledUrl).toContain('apikey=test-fmp-key');
  });
});

// ---------------------------------------------------------------------------
// callApi — Financial Datasets API
// ---------------------------------------------------------------------------

describe('callApi — Financial Datasets API', () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    process.env.FINANCIAL_DATASETS_API_KEY = 'test-fd-key';
    delete process.env.FMP_API_KEY;

    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    fetchSpy.mockRestore();
  });

  test('uses Financial Datasets when key is set', async () => {
    const apiData = { income_statements: [{ revenue: 200000 }] };
    fetchSpy.mockResolvedValueOnce(mockResponse(apiData));

    const result = await callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 });

    expect(result.data).toEqual(apiData);
    expect(result.url).toContain('api.financialdatasets.ai');
  });

  test('writes and reads cache for Financial Datasets', async () => {
    const apiData = { income_statements: [{ revenue: 200000 }] };
    fetchSpy.mockResolvedValueOnce(mockResponse(apiData));

    await callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 }, { cacheable: true });
    const result = await callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 }, { cacheable: true });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual(apiData);
  });
});

// ---------------------------------------------------------------------------
// callApi — No API key
// ---------------------------------------------------------------------------

describe('callApi — no API key', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FINANCIAL_DATASETS_API_KEY;
    delete process.env.FMP_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('throws when no API key is configured', async () => {
    await expect(
      callApi('/financials/income-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 })
    ).rejects.toThrow('No valid financial API key found');
  });
});
