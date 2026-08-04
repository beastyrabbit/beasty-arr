import { describe, expect, it } from "vitest";
import { ProwlarrClient } from "./client.js";

type Call = { url: string; headers: Record<string, string> };

function makeFakeFetch(routes: Record<string, unknown>, calls: Call[] = []) {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const pathname = new URL(url).pathname;
    const body = routes[pathname];
    if (body === undefined) {
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const indexerFixture = [
  {
    id: 1,
    name: "NZBGeek",
    enable: true,
    priority: 1,
    protocol: "usenet",
    fields: [
      { name: "baseSettings.queryLimit", value: 1000 },
      { name: "baseSettings.grabLimit", value: "200" },
      { name: "apiKey", value: "secret" },
    ],
    capabilities: {
      categories: [
        { id: 5000, name: "TV", subCategories: [{ id: 5070, name: "TV/Anime" }] },
        { id: 2000, name: "Movies" },
      ],
    },
  },
  {
    id: 2,
    name: "TorrentTv",
    enable: false,
    protocol: "torrent",
    fields: [{ name: "baseSettings.queryLimit", value: "" }],
    capabilities: { categories: [{ id: 5030, name: "TV/SD" }] },
  },
  {
    id: 3,
    name: "ZeroLimit",
    enable: true,
    protocol: "torrent",
    fields: [{ name: "baseSettings.queryLimit", value: 0 }],
    capabilities: {
      categories: [{ id: 8000, name: "Other", subCategories: [{ id: 2045, name: "Movies/HD" }] }],
    },
  },
];

function makeClient(routes: Record<string, unknown>) {
  const { fetchImpl, calls } = makeFakeFetch(routes);
  const client = new ProwlarrClient({
    baseUrl: "http://prowlarr:9696/", // trailing slash on purpose
    apiKey: "test-prowlarr-key",
    fetchImpl,
  });
  return { client, calls };
}

describe("ProwlarrClient.getIndexers", () => {
  it("parses limits from the fields array and sends the api key header", async () => {
    const { client, calls } = makeClient({ "/api/v1/indexer": indexerFixture });
    const result = await client.getIndexers();
    expect(calls[0].url).toBe("http://prowlarr:9696/api/v1/indexer");
    expect(calls[0].headers["X-Api-Key"]).toBe("test-prowlarr-key");
    expect(result[0]).toMatchObject({
      id: 1,
      name: "NZBGeek",
      enable: true,
      priority: 1,
      protocol: "usenet",
      queryLimit: 1000,
      grabLimit: 200, // string value coerced
    });
  });

  it("treats empty, missing and zero limits as unlimited", async () => {
    const { client } = makeClient({ "/api/v1/indexer": indexerFixture });
    const [, torrentTv, zeroLimit] = await client.getIndexers();
    expect(torrentTv.queryLimit).toBeNull(); // "" = unset
    expect(torrentTv.grabLimit).toBeNull(); // field absent
    expect(zeroLimit.queryLimit).toBeNull(); // 0 = unlimited
  });

  it("derives supportsTv/supportsMovies from Torznab category ranges incl. subcategories", async () => {
    const { client } = makeClient({ "/api/v1/indexer": indexerFixture });
    const [geek, torrentTv, zeroLimit] = await client.getIndexers();
    expect(geek).toMatchObject({ supportsTv: true, supportsMovies: true });
    expect(torrentTv).toMatchObject({ supportsTv: true, supportsMovies: false });
    // 2045 lives in a subCategory of the (non-movie) 8000 category
    expect(zeroLimit).toMatchObject({ supportsTv: false, supportsMovies: true });
  });
});

describe("ProwlarrClient.getHistorySince", () => {
  it("keeps query/grab events in the window and retains source without request URLs", async () => {
    const since = Date.parse("2026-06-15T12:00:00Z");
    const { client } = makeClient({
      "/api/v1/history": {
        records: [
          {
            id: 9,
            indexerId: 1,
            date: "2026-06-15T12:05:00Z",
            eventType: "indexerQuery",
            data: { source: "Sonarr", url: "https://example.invalid/?apikey=secret" },
          },
          {
            id: 8,
            indexerId: 1,
            date: "2026-06-15T12:04:00Z",
            eventType: "releaseGrabbed",
            data: { source: "Radarr" },
          },
          {
            id: 7,
            indexerId: 2,
            date: "2026-06-15T11:59:00Z",
            eventType: "indexerRss",
            data: { source: "Radarr" },
          },
        ],
      },
    });
    await expect(client.getHistorySince(since)).resolves.toEqual([
      {
        id: 9,
        indexerId: 1,
        at: Date.parse("2026-06-15T12:05:00Z"),
        eventType: "indexerQuery",
        source: "Sonarr",
      },
      {
        id: 8,
        indexerId: 1,
        at: Date.parse("2026-06-15T12:04:00Z"),
        eventType: "releaseGrabbed",
        source: "Radarr",
      },
    ]);
  });
});

describe("ProwlarrClient.getIndexerStats", () => {
  it("maps the indexers array with zero-defaults for missing counters", async () => {
    const { client, calls } = makeClient({
      "/api/v1/indexerstats": {
        indexers: [
          {
            indexerId: 1,
            indexerName: "NZBGeek",
            numberOfQueries: 100,
            numberOfRssQueries: 50,
            numberOfAuthQueries: 5,
            numberOfGrabs: 7,
          },
          { indexerId: 2, indexerName: "TorrentTv" },
          { indexerName: "broken-no-id" },
        ],
      },
    });
    const stats = await client.getIndexerStats();
    expect(calls[0].url).toBe("http://prowlarr:9696/api/v1/indexerstats");
    expect(stats).toEqual([
      {
        indexerId: 1,
        indexerName: "NZBGeek",
        numberOfQueries: 100,
        numberOfRssQueries: 50,
        numberOfAuthQueries: 5,
        numberOfGrabs: 7,
      },
      {
        indexerId: 2,
        indexerName: "TorrentTv",
        numberOfQueries: 0,
        numberOfRssQueries: 0,
        numberOfAuthQueries: 0,
        numberOfGrabs: 0,
      },
    ]);
  });
});

describe("ProwlarrClient.getIndexerStatus", () => {
  it("parses disabledTill timestamps into epoch ms", async () => {
    const { client } = makeClient({
      "/api/v1/indexerstatus": [
        { indexerId: 2, disabledTill: "2026-06-15T18:00:00Z" },
        { indexerId: 3, disabledTill: null },
      ],
    });
    const status = await client.getIndexerStatus();
    expect(status).toEqual([
      { indexerId: 2, disabledTill: Date.parse("2026-06-15T18:00:00Z") },
      { indexerId: 3, disabledTill: null },
    ]);
  });
});

describe("ProwlarrClient.getSystemStatus", () => {
  it("returns app name and version", async () => {
    const { client } = makeClient({
      "/api/v1/system/status": { appName: "Prowlarr", version: "1.21.0.4881" },
    });
    await expect(client.getSystemStatus()).resolves.toEqual({
      appName: "Prowlarr",
      version: "1.21.0.4881",
    });
  });
});

describe("ProwlarrClient errors", () => {
  it("throws with status details on non-OK responses", async () => {
    const { client } = makeClient({});
    await expect(client.getIndexers()).rejects.toThrow(/404.*\/api\/v1\/indexer/);
  });
});
