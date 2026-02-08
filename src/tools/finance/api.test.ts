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
    expect(result.url).toContain('/income-statement/AAPL');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('maps balance-sheets endpoint', async () => {
    const fmpData = [{ date: '2024-12-31', totalAssets: 500000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financials/balance-sheets/', { ticker: 'AAPL', period: 'annual', limit: 1 });

    expect(result.data).toEqual({ balance_sheets: fmpData });
    expect(result.url).toContain('/balance-sheet-statement/AAPL');
  });

  test('maps cash-flow-statements endpoint', async () => {
    const fmpData = [{ date: '2024-12-31', operatingCashFlow: 80000 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financials/cash-flow-statements/', { ticker: 'AAPL', period: 'annual', limit: 1 });

    expect(result.data).toEqual({ cash_flow_statements: fmpData });
    expect(result.url).toContain('/cash-flow-statement/AAPL');
  });

  test('maps financial-metrics endpoint (historical ratios)', async () => {
    const fmpData = [{ date: '2024-12-31', peRatio: 25.5 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financial-metrics/', { ticker: 'AAPL', period: 'annual', limit: 4 });

    expect(result.data).toEqual({ financial_metrics: fmpData });
    expect(result.url).toContain('/ratios/AAPL');
  });

  test('maps financial-metrics/snapshot endpoint (TTM ratios)', async () => {
    const fmpData = [{ peRatioTTM: 28.3 }];
    fetchSpy.mockResolvedValueOnce(mockResponse(fmpData));

    const result = await callApi('/financial-metrics/snapshot/', { ticker: 'AAPL' });

    expect(result.data).toEqual({ snapshot: fmpData });
    expect(result.url).toContain('/ratios-ttm/AAPL');
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
  // Unsupported endpoint
  // -------------------------------------------------------------------------

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
