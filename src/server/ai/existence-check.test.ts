import { describe, expect, it } from "vitest";
import {
  assertPublicHttpUrl,
  buildDubCheckSession,
  type DnsLookupFn,
  evidenceClaimsProviderAvailability,
  extractTextFromHtml,
  FETCH_URL_MAX_BYTES,
  FETCH_URL_MAX_TEXT_CHARS,
  fernsehserienPageMatchesTitle,
  fernsehserienSearchPageMatchesTitle,
  fernsehserienSeasonNumber,
  fetchUrlForOracle,
  finalizeDubVerdict,
  germanAggregatorPageMatchesTitle,
  isGermanAggregatorTitleUrl,
  isOfficialProviderTitleUrl,
  isPrivateAddress,
  KNOWLEDGE_ONLY_CONFIDENCE_CAP,
  pageShowsLocalizedGermanSeriesTitle,
  providerPageListsGermanAudio,
  type RawDubVerdict,
  RECHECK_MAX_DAYS,
  RECHECK_MIN_DAYS,
  REPORT_TOOL_NAME,
  seasonPageShowsGermanDatedEpisodes,
  seasonPageShowsLocalizedGermanRelease,
  seasonPageShowsLocalizedGermanSeriesRelease,
  seasonPageShowsOriginalOnlyRelease,
  titlePageShowsGermanProduction,
} from "./existence-check.js";

const publicLookup: DnsLookupFn = async () => [{ address: "93.184.216.34" }];
const privateLookup: DnsLookupFn = async () => [{ address: "10.0.0.7" }];

function fakeResponse(
  body: string,
  init: Omit<Partial<Response>, "headers"> & { headers?: Record<string, string> } = {},
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? { "content-type": "text/html" }),
    body: new Response(body).body,
    text: async () => body,
  } as unknown as Response;
}

async function runTool(tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown) {
  return await (
    tool.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{ content: { type: string; text: string }[]; terminate?: boolean }>
  )("call-1", params, undefined, undefined, {});
}

describe("isPrivateAddress", () => {
  it("blocks private/special IPv4 ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.10",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("blocks private/special IPv6 ranges including v4-mapped", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:192.168.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows public addresses", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1::1")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("treats non-IP garbage as private", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("assertPublicHttpUrl (SSRF guard)", () => {
  it("rejects non-http protocols", async () => {
    await expect(assertPublicHttpUrl("ftp://example.com/x", publicLookup)).rejects.toThrow(
      /http\(s\)/,
    );
    await expect(assertPublicHttpUrl("file:///etc/passwd", publicLookup)).rejects.toThrow();
    await expect(assertPublicHttpUrl("not a url", publicLookup)).rejects.toThrow(/Invalid URL/);
  });

  it("rejects localhost-ish hostnames and embedded credentials", async () => {
    await expect(assertPublicHttpUrl("http://localhost:9898/", publicLookup)).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://foo.localhost/", publicLookup)).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://nas.local/", publicLookup)).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://user:pw@example.com/", publicLookup)).rejects.toThrow(
      /credentials/,
    );
  });

  it("rejects private IP literals (v4 and v6)", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://10.0.0.5/admin",
      "http://192.168.1.10:8989/",
      "http://172.20.3.4/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[::ffff:192.168.0.1]/",
    ]) {
      await expect(assertPublicHttpUrl(url, publicLookup), url).rejects.toThrow(/Blocked/);
    }
  });

  it("normalizes decimal/hex IP obfuscation via the URL parser", async () => {
    // WHATWG URL canonicalizes 2130706433 → 127.0.0.1.
    await expect(assertPublicHttpUrl("http://2130706433/", publicLookup)).rejects.toThrow();
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    await expect(assertPublicHttpUrl("https://evil.example.com/", privateLookup)).rejects.toThrow(
      /private address/,
    );
  });

  it("rejects on DNS failure and allows public hosts", async () => {
    const failing: DnsLookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicHttpUrl("https://x.example.com/", failing)).rejects.toThrow(
      /DNS lookup failed/,
    );
    const url = await assertPublicHttpUrl("https://www.synchronkartei.de/suche?q=x", publicLookup);
    expect(url.hostname).toBe("www.synchronkartei.de");
    const ipUrl = await assertPublicHttpUrl("http://93.184.216.34/", publicLookup);
    expect(ipUrl.hostname).toBe("93.184.216.34");
  });
});

describe("extractTextFromHtml", () => {
  it("strips scripts, styles, tags and decodes entities", () => {
    const html = `<html><head><style>.x{color:red}</style><script>alert(1)</script></head>
      <body><h1>Die Serie</h1><p>Staffel 1 &amp; 2 sind auf Deutsch verf&uuml;gbar.</p>
      <div>Mehr&nbsp;Infos &lt;hier&gt;</div></body></html>`;
    const text = extractTextFromHtml(html);
    expect(text).toContain("Die Serie");
    expect(text).toContain("Staffel 1 & 2");
    expect(text).toContain("Mehr Infos <hier>");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<p>");
  });

  it("preserves structured abbreviation labels used for audio and country metadata", () => {
    const text = extractTextFromHtml(
      '<title>Adam &amp; Ida – Die lange Suche der Zwillinge – fernsehserien.de</title><main><abbr class="label-sprache" title="Sprache: Deutsch">de</abbr> <abbr itemprop="countryOfOrigin" title="Deutschland">D</abbr> 2022</main>',
    );
    expect(text).toBe(
      "Adam & Ida – Die lange Suche der Zwillinge – fernsehserien.de\nde (Sprache: Deutsch) D (Deutschland) 2022",
    );
  });
});

describe("fetchUrlForOracle", () => {
  it("fetches and extracts text", async () => {
    const fetchImpl = (async () =>
      fakeResponse(
        "<html><body><p>Deutsche Synchronfassung existiert.</p></body></html>",
      )) as unknown as typeof fetch;
    const page = await fetchUrlForOracle("https://example.com/", {
      fetchImpl,
      lookupFn: publicLookup,
    });
    expect(page).toEqual({
      text: "Deutsche Synchronfassung existiert.",
      finalUrl: "https://example.com/",
    });
  });

  it("re-validates every redirect hop and blocks private targets", async () => {
    const fetchImpl = (async () =>
      fakeResponse("", {
        status: 302,
        ok: false,
        headers: { location: "http://192.168.1.5/internal" },
      })) as unknown as typeof fetch;
    await expect(
      fetchUrlForOracle("https://example.com/", { fetchImpl, lookupFn: publicLookup }),
    ).rejects.toThrow(/Blocked/);
  });

  it("caps extracted text at 100k characters", async () => {
    const fetchImpl = (async () =>
      fakeResponse("x".repeat(FETCH_URL_MAX_TEXT_CHARS + 5000), {
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    const page = await fetchUrlForOracle("https://example.com/", {
      fetchImpl,
      lookupFn: publicLookup,
    });
    expect(page.text.length).toBeLessThanOrEqual(FETCH_URL_MAX_TEXT_CHARS + 20);
    expect(page.text.endsWith("[truncated]")).toBe(true);
  });

  it("throws on error statuses", async () => {
    const fetchImpl = (async () =>
      fakeResponse("nope", { ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(
      fetchUrlForOracle("https://example.com/missing", { fetchImpl, lookupFn: publicLookup }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("buildDubCheckSession", () => {
  const subject = {
    kind: "series" as const,
    title: "Some Show",
    year: 2020,
    originalLanguage: "japanese",
    externalIds: { tvdbId: 123, imdbId: "tt1" },
    seasons: [1, 2],
  };

  it("has exactly one terminating tool and fetch_url; search only with SEARXNG_URL", () => {
    const session = buildDubCheckSession(subject);
    expect(session.terminatingTool).toBe(REPORT_TOOL_NAME);
    expect(session.tools.map((tool) => tool.name).sort()).toEqual(["fetch_url", REPORT_TOOL_NAME]);
    const withSearch = buildDubCheckSession(subject, { searxngUrl: "http://searx.example.com" });
    expect(withSearch.tools.map((tool) => tool.name)).toContain("search_web");
    expect(session.prompt).toContain('"tvdbId": 123');
    expect(session.system).toContain("synchronkartei.de");
    expect(session.system).toContain("spring/summer/autumn/winter → Mar/Jun/Sep/Dec 01");
    expect(session.system).toContain("exactly one perSeason entry for EVERY requested season");
    expect(session.system).toContain("Provider search, browse, login, press/media");
    expect(session.system).toContain("provider page being inaccessible is NOT by itself");
    expect(session.system).toContain("German production");
    expect(session.system).toContain("deutsche Version");
    expect(session.system).toContain("concert/performance film");
    expect(session.system).toContain("audience questions");
    expect(session.system).toContain("require normal German-audio proof");
    expect(session.system).toContain("de (Sprache: Deutsch)");
    expect(session.prompt).toContain("every requested season: 1, 2");
  });

  it("recognizes exact provider title pages and keeps subtitles separate from audio", () => {
    expect(isOfficialProviderTitleUrl("https://www.netflix.com/de/title/81234567")).toBe(true);
    expect(isOfficialProviderTitleUrl("https://www.netflix.com/search?q=show")).toBe(false);
    expect(isOfficialProviderTitleUrl("https://www.primevideo.com/detail/0ABC123")).toBe(true);
    expect(isGermanAggregatorTitleUrl("https://www.justwatch.com/de/Film/Being-Eddie")).toBe(true);
    expect(isGermanAggregatorTitleUrl("https://www.justwatch.com/de/suche?q=show")).toBe(false);
    expect(
      isGermanAggregatorTitleUrl("https://www.fernsehserien.de/filme/all-die-leeren-zimmer"),
    ).toBe(true);
    expect(isGermanAggregatorTitleUrl("https://www.fernsehserien.de/batwheels")).toBe(true);
    expect(
      isGermanAggregatorTitleUrl("https://www.fernsehserien.de/batwheels/episodenguide/staffel-3"),
    ).toBe(true);
    expect(
      isGermanAggregatorTitleUrl(
        "https://www.fernsehserien.de/suche/adam-ida-die-lange-suche-der-zwillinge",
      ),
    ).toBe(false);
    expect(isGermanAggregatorTitleUrl("https://www.fernsehserien.de/suche?q=show")).toBe(false);
    expect(isGermanAggregatorTitleUrl("https://www.fernsehserien.de/filme")).toBe(false);
    expect(isGermanAggregatorTitleUrl("https://www.fernsehserien.de/news")).toBe(false);
    expect(providerPageListsGermanAudio("Audio\nEnglish, Deutsch\nUntertitel\nEnglish")).toBe(true);
    expect(providerPageListsGermanAudio("Audio\nEnglish\nUntertitel\nDeutsch, English")).toBe(
      false,
    );
    expect(
      providerPageListsGermanAudio(
        "Netflix (Englisch)\nStreaming & Mediatheken\nde (Sprache: Deutsch) en (ov)\nUT de (Untertitel: Deutsch)",
      ),
    ).toBe(true);
    expect(
      providerPageListsGermanAudio(
        "Netflix (Englisch)\nStreaming & Mediatheken\nen (ov) (Sprache: Englisch)\nUT de (Untertitel: Deutsch)",
      ),
    ).toBe(false);
    expect(titlePageShowsGermanProduction("Adam & Ida\nD (Deutschland) 2022 (80 Min.)", 2022)).toBe(
      true,
    );
    expect(titlePageShowsGermanProduction("Arena (ARD)\nD (Deutschland) 2025", 2011)).toBe(false);
    expect(titlePageShowsGermanProduction("Some Film\nUSA 2022\nDeutsche TV-Premiere", 2022)).toBe(
      false,
    );
    expect(
      fernsehserienSearchPageMatchesTitle(
        "https://www.fernsehserien.de/suche/adam-ida-die-lange-suche-der-zwillinge",
        "Adam & Ida – fernsehserien.de\nSendetermine Adam & Ida – Die lange Suche der Zwillinge\nD (Deutschland) 2022",
        "Adam & Ida - Die lange Suche der Zwillinge",
      ),
    ).toBe(true);
    expect(
      fernsehserienSearchPageMatchesTitle(
        "https://www.fernsehserien.de/suche/anonymous-club",
        "Vampire Club – fernsehserien.de\nde (Sprache: Deutsch)",
        "Anonymous Club",
      ),
    ).toBe(false);
    expect(
      fernsehserienSearchPageMatchesTitle(
        "https://www.fernsehserien.de/suche/r-xmas",
        "Suche nach r-xmas – fernsehserien.de\nD (Deutschland) 2022",
        "'R Xmas",
      ),
    ).toBe(false);
    expect(
      fernsehserienPageMatchesTitle(
        "https://www.fernsehserien.de/impractical-jokers/episodenguide/staffel-1",
        "Impractical Jokers – Die Lachflasher! Staffel 1 Episodenguide – fernsehserien.de\nStaffel 1",
        "Impractical Jokers",
      ),
    ).toBe(true);
    expect(
      fernsehserienPageMatchesTitle(
        "https://www.fernsehserien.de/vampire-club/episodenguide/staffel-1",
        "Vampire Club Staffel 1 Episodenguide – fernsehserien.de\nStaffel 1",
        "Anonymous Club",
      ),
    ).toBe(false);
  });

  it("recognizes localized German season releases but not premieres marked as OmU", () => {
    expect(
      fernsehserienSeasonNumber(
        "https://www.fernsehserien.de/impractical-jokers/episodenguide/staffel-6",
      ),
    ).toBe(6);
    expect(
      seasonPageShowsLocalizedGermanRelease(
        "1. Vom Hund in die Hand (Pay It Forward)\nDeutsche TV-Premiere 17.06.2015 sixx",
      ),
    ).toBe(true);
    expect(
      seasonPageShowsLocalizedGermanRelease(
        "1. Deutscher Titel (Original Title)\nDeutsche Streaming-Premiere\nOmU (Original mit Untertiteln)",
      ),
    ).toBe(false);
    expect(
      seasonPageShowsLocalizedGermanSeriesRelease(
        "Impractical Jokers – Die Lachflasher! Staffel 6 Episodenguide – fernsehserien.de\nSwim Shady (Swim Shady)\nDeutsche TV-Premiere 18.09.2019 DMAX",
        "Impractical Jokers",
      ),
    ).toBe(true);
    expect(
      pageShowsLocalizedGermanSeriesTitle(
        "Impractical Jokers – Die Lachflasher! – fernsehserien.de\nUS-Comedyshow",
        "Impractical Jokers",
      ),
    ).toBe(true);
    expect(
      seasonPageShowsLocalizedGermanSeriesRelease(
        "The House that Dragons Built Staffel 1 Episodenguide – fernsehserien.de\nFolge 1 (The Heirs of the Dragon)\nDeutsche TV-Premiere 07.10.2022\nOmU (Original mit Untertiteln)",
        "The House that Dragons Built",
      ),
    ).toBe(false);
    expect(
      seasonPageShowsOriginalOnlyRelease(
        "Deutsche TV-Premiere 07.10.2022\nOmU (Original mit Untertiteln)",
      ),
    ).toBe(true);
    expect(
      seasonPageShowsLocalizedGermanRelease(
        "Folge 19 (Salt And Sea, Fire And Blood)\nDeutsche TV-Premiere 29.06.2026",
      ),
    ).toBe(false);
    expect(
      seasonPageShowsGermanDatedEpisodes(
        "Staffel 5\n108 5.01\n5.\n01\nHellCopter HellCopter\n12.06.2019 11.02.2016\nHellCopter\n11.02.2016\nStaffel 6\n135 6.01",
        5,
      ),
    ).toBe(true);
    expect(
      seasonPageShowsGermanDatedEpisodes(
        "Staffel 4\n78 4.01\n4.\n01\nWelcome to Miami\n29.01.2015\nWelcome to Miami\n29.01.2015\nStaffel 5\n108 5.01",
        4,
      ),
    ).toBe(false);
  });

  it("rejects a JustWatch redirect to a similarly named parent series", () => {
    expect(
      germanAggregatorPageMatchesTitle(
        "https://www.justwatch.com/de/Serie/the-house-that-dragons-built/staffel-1",
        "House of the Dragon Staffel 1 - Jetzt Stream anschauen",
        "The House that Dragons Built",
      ),
    ).toBe(false);
    expect(
      germanAggregatorPageMatchesTitle(
        "https://www.justwatch.com/de/Film/13-Cameras",
        "13 Cameras - Stream: Jetzt Film online finden und anschauen",
        "13 Cameras",
      ),
    ).toBe(true);
  });

  it("requires an affirmative provider availability claim instead of a provider name", () => {
    expect(
      evidenceClaimsProviderAvailability([
        "JustWatch says the movie is currently available to stream on Netflix.",
      ]),
    ).toBe(true);
    expect(
      evidenceClaimsProviderAvailability([
        "JustWatch provider filters include Netflix, Prime Video and Disney+.",
      ]),
    ).toBe(false);
    expect(
      evidenceClaimsProviderAvailability(["The movie is not available to stream on Netflix."]),
    ).toBe(false);
  });

  it("tracks exact provider pages and German audio separately", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      return fakeResponse(
        url.includes("netflix.com/title/")
          ? `${subject.title}\n${subject.year}\nAudio\nEnglish, Deutsch\nUntertitel\nEnglish`
          : "Stream Some Show on Netflix",
        { headers: { "content-type": "text/plain" } },
      );
    }) as unknown as typeof fetch;
    const session = buildDubCheckSession(subject, { fetchImpl, lookupFn: publicLookup });
    const fetchTool = session.tools.find((tool) => tool.name === "fetch_url");
    await runTool(fetchTool as never, { url: "https://www.justwatch.com/de/Serie/Some-Show" });
    expect(
      session.providerAvailabilityDetected([
        "JustWatch says the series is available to stream on Netflix.",
      ]),
    ).toBe(true);
    expect(session.fetchedOfficialProviderTitle()).toBe(false);
    await runTool(fetchTool as never, { url: "https://www.netflix.com/title/81234567" });
    expect(session.fetchedOfficialProviderTitle()).toBe(true);
    expect(session.titlePageHasGermanAudio()).toBe(true);
  });

  it("tracks localized German releases only for the exact fetched season", async () => {
    const fetchImpl = (async () =>
      fakeResponse(
        "Some Show – Deutscher Titel Staffel 1 Episodenguide – fernsehserien.de\n1. Vom Hund in die Hand (Pay It Forward)\nDeutsche TV-Premiere 17.06.2015 sixx",
        { headers: { "content-type": "text/plain" } },
      )) as unknown as typeof fetch;
    const session = buildDubCheckSession(subject, { fetchImpl, lookupFn: publicLookup });
    const fetchTool = session.tools.find((tool) => tool.name === "fetch_url");
    await runTool(fetchTool as never, {
      url: "https://www.fernsehserien.de/some-show/episodenguide/staffel-1",
    });
    expect(session.localizedGermanSeasonReleases()).toEqual([
      {
        season: 1,
        url: "https://www.fernsehserien.de/some-show/episodenguide/staffel-1",
      },
    ]);
    expect(session.originalOnlySeasonReleases()).toEqual([]);
  });

  it("does not attribute a redirected series guide to the requested season", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/episodenguide/staffel-13")) {
        return fakeResponse("", {
          status: 301,
          ok: false,
          headers: { location: "/impractical-jokers-die-lachflasher/episodenguide" },
        });
      }
      return fakeResponse(
        "Impractical Jokers – Die Lachflasher! Episodenguide – fernsehserien.de\nStaffel 6\nDeutsche TV-Premiere 18.09.2019 DMAX",
        { headers: { "content-type": "text/plain" } },
      );
    }) as unknown as typeof fetch;
    const redirectedSubject = { ...subject, title: "Impractical Jokers", seasons: [13] };
    const session = buildDubCheckSession(redirectedSubject, { fetchImpl, lookupFn: publicLookup });
    const fetchTool = session.tools.find((tool) => tool.name === "fetch_url");
    await runTool(fetchTool as never, {
      url: "https://www.fernsehserien.de/impractical-jokers/episodenguide/staffel-13",
    });
    expect(session.fetchedUrls()).toEqual([
      "https://www.fernsehserien.de/impractical-jokers-die-lachflasher/episodenguide",
    ]);
    expect(session.localizedGermanSeasonReleases()).toEqual([]);
    expect(session.originalOnlySeasonReleases()).toEqual([]);
  });

  it("combines a localized series title page with each exact German-broadcast season", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      return fakeResponse(
        url.endsWith("/some-show")
          ? "Some Show – Deutscher Titel – fernsehserien.de\nDeutsche TV-Premiere 2020"
          : "Some Show Staffel 2 Episodenguide – fernsehserien.de\nEpisode (Episode)\nDeutsche TV-Premiere 18.09.2021 DMAX",
        { headers: { "content-type": "text/plain" } },
      );
    }) as unknown as typeof fetch;
    const session = buildDubCheckSession(subject, { fetchImpl, lookupFn: publicLookup });
    const fetchTool = session.tools.find((tool) => tool.name === "fetch_url");
    await runTool(fetchTool as never, { url: "https://www.fernsehserien.de/some-show" });
    await runTool(fetchTool as never, {
      url: "https://www.fernsehserien.de/some-show/episodenguide/staffel-2",
    });
    expect(session.localizedGermanSeasonReleases()).toEqual([
      {
        season: 2,
        url: "https://www.fernsehserien.de/some-show/episodenguide/staffel-2",
      },
    ]);
  });

  it("captures the verdict through the terminating tool and terminates", async () => {
    const session = buildDubCheckSession(subject);
    const report = session.tools.find((tool) => tool.name === REPORT_TOOL_NAME);
    expect(report).toBeDefined();
    const result = await runTool(report as never, {
      verdict: "exists",
      confidence: 0.9,
      evidence: ["synchronkartei entry"],
      recheckAfterDays: 400,
    });
    expect(result.terminate).toBe(true);
    expect(session.getVerdict()).toMatchObject({ verdict: "exists", confidence: 0.9 });
  });

  it("tracks fetch success via the fetch_url tool wrapper", async () => {
    const fetchImpl = (async () =>
      fakeResponse("<p>Deutsche Fassung</p>")) as unknown as typeof fetch;
    const session = buildDubCheckSession(subject, { fetchImpl, lookupFn: publicLookup });
    expect(session.fetchSucceeded()).toBe(false);
    expect(session.fetchedUrls()).toEqual([]);
    const fetchTool = session.tools.find((tool) => tool.name === "fetch_url");
    await runTool(fetchTool as never, { url: "https://www.synchronkartei.de/suche?q=Some+Show" });
    expect(session.fetchSucceeded()).toBe(true);
    expect(session.fetchedUrls()).toEqual(["https://www.synchronkartei.de/suche?q=Some+Show"]);
  });

  it("keeps fetchSucceeded false when the fetch fails (guard or network)", async () => {
    const session = buildDubCheckSession(subject, { lookupFn: publicLookup });
    const fetchTool = session.tools.find((tool) => tool.name === "fetch_url");
    const result = await runTool(fetchTool as never, { url: "http://127.0.0.1/steal" });
    expect(result.content[0]?.text).toMatch(/fetch_url failed/);
    expect(session.fetchSucceeded()).toBe(false);
  });
});

describe("finalizeDubVerdict", () => {
  const base: RawDubVerdict = {
    verdict: "unlikely",
    confidence: 0.9,
    evidence: ["no synchronkartei entry"],
    recheckAfterDays: 200,
  };

  it("degrades a missing verdict to unknown/0", () => {
    const final = finalizeDubVerdict(undefined, false);
    expect(final).toMatchObject({
      verdict: "unknown",
      confidence: 0,
      recheckAfterDays: RECHECK_MIN_DAYS,
    });
  });

  it("degrades an invalid verdict value to unknown", () => {
    const final = finalizeDubVerdict({ ...base, verdict: "maybe" as never }, true);
    expect(final.verdict).toBe("unknown");
  });

  it("clamps recheckAfterDays to [90, 730]", () => {
    expect(finalizeDubVerdict({ ...base, recheckAfterDays: 5 }, true).recheckAfterDays).toBe(
      RECHECK_MIN_DAYS,
    );
    expect(finalizeDubVerdict({ ...base, recheckAfterDays: 10_000 }, true).recheckAfterDays).toBe(
      RECHECK_MAX_DAYS,
    );
    expect(finalizeDubVerdict({ ...base, recheckAfterDays: 200 }, true).recheckAfterDays).toBe(200);
  });

  it("caps knowledge-only confidence at 0.6 but keeps verified confidence", () => {
    expect(finalizeDubVerdict(base, false).confidence).toBe(KNOWLEDGE_ONLY_CONFIDENCE_CAP);
    expect(finalizeDubVerdict(base, true).confidence).toBe(0.9);
    expect(finalizeDubVerdict({ ...base, confidence: 4 }, true).confidence).toBe(1);
    expect(finalizeDubVerdict({ ...base, confidence: Number.NaN }, true).confidence).toBe(0);
  });

  it("parses expectedAvailability and filters bad perSeason entries", () => {
    const final = finalizeDubVerdict(
      {
        ...base,
        verdict: "announced",
        expectedAvailability: "2026-09-01",
        perSeason: [
          {
            season: 1,
            verdict: "exists",
            confidence: 0.95,
            evidence: ["season source"],
            recheckAfterDays: 120,
          },
          {
            season: 2.5,
            verdict: "exists",
            confidence: 0.9,
            evidence: [],
            recheckAfterDays: 90,
          },
          {
            season: 3,
            verdict: "nope" as never,
            confidence: 0.9,
            evidence: [],
            recheckAfterDays: 90,
          },
        ],
      },
      true,
    );
    expect(final.expectedAvailability).toBe(Date.parse("2026-09-01"));
    expect(final.perSeason).toEqual([
      {
        season: 1,
        verdict: "exists",
        confidence: 0.95,
        evidence: ["season source"],
        expectedAvailability: null,
        recheckAfterDays: 120,
      },
    ]);
    expect(
      finalizeDubVerdict({ ...base, expectedAvailability: "soon" }, true).expectedAvailability,
    ).toBeNull();
  });
});

it("stops reading and cancels once the decoded document limit is exceeded", async () => {
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await expect(
    fetchUrlForOracle("https://example.com/document", {
      lookupFn: publicLookup,
      fetchImpl: async () => new Response(stream, { headers: { "content-type": "text/plain" } }),
    }),
  ).rejects.toThrow("decoded bytes");
  expect(cancelled).toBe(true);
  expect(reads).toBe(FETCH_URL_MAX_BYTES / (512 * 1024) + 1);
});
