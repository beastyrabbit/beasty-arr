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
    expect(result.evidence.get("radarr:1")?.url).toBe("https://www.synchronkartei.de/film/81");
    expect(result.evidence.get("sonarr:2")?.url).toBe("https://www.synchronkartei.de/serie/92");
    expect(result.checkedSubjectKeys).toEqual(new Set(["radarr:1", "sonarr:2"]));
    expect(result.failures).toEqual([]);
  });

  it("reports a rejected batch without marking its subjects as checked", async () => {
    const fetchImpl = (async () =>
      new Response("busy", { status: 429 })) as unknown as typeof fetch;
    const result = await lookupDubCatalog(
      [subject("radarr:1", "movie", { imdbId: "tt1234567" })],
      fetchImpl,
    );
    expect(result.evidence).toEqual(new Map());
    expect(result.checkedSubjectKeys).toEqual(new Set());
    expect(result.failures).toEqual([
      { subjectKeys: ["radarr:1"], error: "Wikidata dub catalog returned HTTP 429." },
    ]);
  });

  it("keeps successful later batches when an earlier batch fails", async () => {
    let request = 0;
    const fetchImpl = (async () => {
      request += 1;
      if (request === 1) return new Response("busy", { status: 429 });
      return new Response(
        JSON.stringify({
          results: {
            bindings: [{ imdb: { value: "tt9999999" }, filmDub: { value: "99" } }],
          },
        }),
        { status: 200, headers: { "content-type": "application/sparql-results+json" } },
      );
    }) as unknown as typeof fetch;
    const subjects = Array.from({ length: 101 }, (_, index) =>
      subject(`radarr:${index + 1}`, "movie", {
        imdbId: index === 100 ? "tt9999999" : `tt${String(index + 1).padStart(7, "0")}`,
      }),
    );

    const result = await lookupDubCatalog(subjects, fetchImpl);

    expect(result.evidence.get("radarr:101")?.sourceId).toBe("99");
    expect(result.checkedSubjectKeys).toEqual(new Set(["radarr:101"]));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.subjectKeys).toHaveLength(100);
  });
});
