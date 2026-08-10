import { describe, expect, it } from "vitest";
import { lookupDubCatalog } from "./dub-catalog.js";
import type { OracleCheckSubject } from "./oracle-service.js";

function subject(
  subjectKey: string,
  kind: "series" | "movie",
  externalIds: OracleCheckSubject["externalIds"],
): OracleCheckSubject {
  return {
    subjectKey,
    subjectKind: kind,
    source: kind === "series" ? "sonarr" : "radarr",
    subjectId: Number(subjectKey.split(":")[1]),
    title: subjectKey,
    year: 2020,
    originalLanguage: "english",
    externalIds,
  };
}

describe("lookupDubCatalog", () => {
  it("batch-matches Wikidata Synchronkartei IDs without scraping the catalog", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      requests.push(init);
      return new Response(
        JSON.stringify({
          results: {
            bindings: [
              { imdb: { value: "tt1234567" }, filmDub: { value: "81" } },
              { tvdb: { value: "7654" }, seriesDub: { value: "92" } },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/sparql-results+json" } },
      );
    }) as unknown as typeof fetch;
    const result = await lookupDubCatalog(
      [
        subject("radarr:1", "movie", { imdbId: "tt1234567", tmdbId: 123 }),
        subject("sonarr:2", "series", { tvdbId: 7654 }),
      ],
      fetchImpl,
    );

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body)).toContain("P3844");
    expect(String(requests[0]?.body)).toContain("P4834");
    expect(result.get("radarr:1")?.url).toBe("https://www.synchronkartei.de/film/81");
    expect(result.get("sonarr:2")?.url).toBe("https://www.synchronkartei.de/serie/92");
  });

  it("fails clearly when Wikidata rejects a batch", async () => {
    const fetchImpl = (async () =>
      new Response("busy", { status: 429 })) as unknown as typeof fetch;
    await expect(
      lookupDubCatalog([subject("radarr:1", "movie", { imdbId: "tt1234567" })], fetchImpl),
    ).rejects.toThrow(/HTTP 429/);
  });
});
