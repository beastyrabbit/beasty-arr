import { arrFetch } from "../arr/http-util.js";

/** Torznab category ranges used to derive per-indexer media support. */
const TV_CATEGORY_MIN = 5000;
const TV_CATEGORY_MAX = 5999;
const MOVIE_CATEGORY_MIN = 2000;
const MOVIE_CATEGORY_MAX = 2999;

const REQUEST_TIMEOUT_MS = 30_000;

export type ProwlarrIndexer = {
  id: number;
  name: string;
  enable: boolean;
  protocol: string; // usenet|torrent
  /** Daily query limit from 'baseSettings.queryLimit'; null/0/empty = unlimited. */
  queryLimit: number | null;
  /** Daily grab limit from 'baseSettings.grabLimit'; null/0/empty = unlimited. */
  grabLimit: number | null;
  supportsTv: boolean;
  supportsMovies: boolean;
};

export type ProwlarrIndexerStats = {
  indexerId: number;
  indexerName: string;
  numberOfQueries: number;
  numberOfRssQueries: number;
  numberOfAuthQueries: number;
  numberOfGrabs: number;
};

export type ProwlarrIndexerStatus = {
  indexerId: number;
  /** Epoch ms until which Prowlarr has disabled the indexer; null = not disabled. */
  disabledTill: number | null;
};

export type ProwlarrSystemStatus = {
  appName: string;
  version: string;
};

type RawField = { name?: string; value?: unknown };
type RawCategory = { id?: number; subCategories?: RawCategory[] };
type RawIndexer = {
  id: number;
  name: string;
  enable?: boolean;
  protocol?: string;
  fields?: RawField[];
  capabilities?: { categories?: RawCategory[] };
};
type RawIndexerStats = {
  indexers?: {
    indexerId?: number;
    indexerName?: string;
    numberOfQueries?: number;
    numberOfRssQueries?: number;
    numberOfAuthQueries?: number;
    numberOfGrabs?: number;
  }[];
};
type RawIndexerStatus = { indexerId?: number; disabledTill?: string | null };
type RawSystemStatus = { appName?: string; version?: string };

function parseLimit(fields: RawField[] | undefined, name: string): number | null {
  const field = fields?.find((f) => f.name === name);
  if (!field || field.value == null || field.value === "") return null;
  const num = Number(field.value);
  // Prowlarr semantics: 0 (or unset) means unlimited.
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function collectCategoryIds(categories: RawCategory[] | undefined, out: number[] = []): number[] {
  for (const cat of categories ?? []) {
    if (typeof cat.id === "number") out.push(cat.id);
    collectCategoryIds(cat.subCategories, out);
  }
  return out;
}

function parseIndexer(raw: RawIndexer): ProwlarrIndexer {
  const categoryIds = collectCategoryIds(raw.capabilities?.categories);
  return {
    id: raw.id,
    name: raw.name,
    enable: raw.enable ?? false,
    protocol: raw.protocol ?? "unknown",
    queryLimit: parseLimit(raw.fields, "baseSettings.queryLimit"),
    grabLimit: parseLimit(raw.fields, "baseSettings.grabLimit"),
    supportsTv: categoryIds.some((id) => id >= TV_CATEGORY_MIN && id <= TV_CATEGORY_MAX),
    supportsMovies: categoryIds.some((id) => id >= MOVIE_CATEGORY_MIN && id <= MOVIE_CATEGORY_MAX),
  };
}

export class ProwlarrClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getIndexers(): Promise<ProwlarrIndexer[]> {
    const raw = await this.fetchJson<RawIndexer[]>("/api/v1/indexer");
    return raw.map(parseIndexer);
  }

  async getIndexerStats(): Promise<ProwlarrIndexerStats[]> {
    const raw = await this.fetchJson<RawIndexerStats>("/api/v1/indexerstats");
    return (raw.indexers ?? [])
      .filter((s) => typeof s.indexerId === "number")
      .map((s) => ({
        indexerId: s.indexerId as number,
        indexerName: s.indexerName ?? "",
        numberOfQueries: s.numberOfQueries ?? 0,
        numberOfRssQueries: s.numberOfRssQueries ?? 0,
        numberOfAuthQueries: s.numberOfAuthQueries ?? 0,
        numberOfGrabs: s.numberOfGrabs ?? 0,
      }));
  }

  async getIndexerStatus(): Promise<ProwlarrIndexerStatus[]> {
    const raw = await this.fetchJson<RawIndexerStatus[]>("/api/v1/indexerstatus");
    return raw
      .filter((s) => typeof s.indexerId === "number")
      .map((s) => {
        const till = s.disabledTill ? Date.parse(s.disabledTill) : Number.NaN;
        return {
          indexerId: s.indexerId as number,
          disabledTill: Number.isFinite(till) ? till : null,
        };
      });
  }

  async getSystemStatus(): Promise<ProwlarrSystemStatus> {
    const raw = await this.fetchJson<RawSystemStatus>("/api/v1/system/status");
    return { appName: raw.appName ?? "Prowlarr", version: raw.version ?? "unknown" };
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await arrFetch(
      url,
      { headers: { "X-Api-Key": this.apiKey, Accept: "application/json" } },
      { fetchImpl: this.fetchImpl, timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (!res.ok) {
      throw new Error(`Prowlarr request failed: ${res.status} ${res.statusText} (${path})`);
    }
    return (await res.json()) as T;
  }
}
