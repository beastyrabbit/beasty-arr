/** Typed fetch wrapper: JSON in/out with normalized server/network errors. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiConfig = {
  fetchFn: typeof fetch;
};

const config: ApiConfig = {
  fetchFn: (...args) => fetch(...args),
};

export function configureApi(patch: Partial<ApiConfig>): void {
  Object.assign(config, patch);
}

export type QueryParams = Record<
  string,
  string | number | boolean | readonly (string | number)[] | undefined
>;

export function buildQueryString(query: QueryParams | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else {
      params.set(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; query?: QueryParams } = {},
): Promise<T> {
  const url = `${path}${buildQueryString(opts.query)}`;
  let res: Response;
  try {
    res = await config.fetchFn(url, {
      method,
      credentials: "same-origin",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "network error");
  }

  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string, query?: QueryParams) => request<T>("GET", path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
