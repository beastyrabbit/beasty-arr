/**
 * Shared fetch wrapper for the arr clients: per-attempt timeout via
 * AbortSignal.timeout plus bounded retries on transient failures
 * (408/429/5xx and network errors). Fetch is injectable so tests never
 * touch the network.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;

export type ArrFetchOptions = {
  fetchImpl?: FetchImpl;
  /** Per-attempt timeout; aborts the in-flight request. Default 30s. */
  timeoutMs?: number;
  /** Additional attempts after the first on retryable failures. Default 2. */
  retries?: number;
  /** Base delay before a retry; doubles per attempt. Default 500ms. */
  retryDelayMs?: number;
};

/** Connection options every arr client takes. */
export type ArrClientOptions = ArrFetchOptions & {
  baseUrl: string;
  apiKey: string;
};

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function arrFetch(
  url: string,
  init: RequestInit = {},
  options: ArrFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await delay(retryDelayMs * 2 ** (attempt - 1));
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetchImpl(url, { ...init, signal });
      if (isRetryableStatus(response.status) && attempt < retries) {
        // Discard the transient-failure body so the connection can be reused.
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      return response;
    } catch (error) {
      // A caller-initiated abort must win over the retry loop.
      if (init.signal?.aborted) {
        throw error;
      }
      lastError = error;
      if (attempt >= retries) {
        throw error;
      }
    }
  }
  throw lastError; // unreachable — loop always returns or throws
}
