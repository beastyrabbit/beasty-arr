import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AI_VERDICTS, type AiVerdictValue } from "../../shared/domain.js";

export const PROMPT_VERSION = "dub-oracle-v6";
export const REPORT_TOOL_NAME = "report_dub_verdict";

export const RECHECK_MIN_DAYS = 90;
export const RECHECK_MAX_DAYS = 730;
/** Verdicts without a single successful web fetch are knowledge-only — cap them. */
export const KNOWLEDGE_ONLY_CONFIDENCE_CAP = 0.6;

export const FETCH_URL_TIMEOUT_MS = 15_000;
export const FETCH_URL_MAX_TEXT_CHARS = 100_000;
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const JUSTWATCH_GERMAN_TITLE_PATH_RE = /^\/de\/(?:film|serie)\//;
const FERNSEHSERIEN_MOVIE_PATH_RE = /^\/filme\/[^/]+\/?$/;
const FERNSEHSERIEN_SERIES_PATH_RE = /^\/[^/]+\/?$/;
const FERNSEHSERIEN_SEASON_PATH_RE = /^\/[^/]+\/episodenguide\/staffel-\d+\/?$/;
const FERNSEHSERIEN_GERMAN_AUDIO_RE = /\bde\s*\(\s*Sprache:\s*Deutsch\s*\)/i;
const FERNSEHSERIEN_RESERVED_PATHS = new Set([
  "/datenschutz",
  "/filme",
  "/impressum",
  "/login",
  "/news",
  "/registrieren",
  "/sender",
  "/sendetermine",
  "/serien",
  "/stars",
  "/streaming",
  "/suche",
]);

// ============ SSRF guard ============

export type DnsLookupFn = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: DnsLookupFn = async (hostname) => await dnsLookup(hostname, { all: true });

/** True for loopback/private/link-local/CGNAT/multicast addresses (and non-IP garbage). */
export function isPrivateAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // CGNAT
    if (a !== undefined && a >= 224) return true; // multicast/reserved/broadcast
    return false;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    // The WHATWG URL parser canonicalizes v4-mapped literals to hex groups.
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex?.[1] && mappedHex[2]) {
      const hi = Number.parseInt(mappedHex[1], 16);
      const lo = Number.parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
    return false;
  }
  return true;
}

/**
 * SSRF guard for the oracle's web tools: http(s) only, no credentials, no
 * localhost-ish hostnames, no IP-literal or DNS-resolved private addresses.
 * (DNS re-resolution between check and fetch is accepted for this threat model.)
 */
export async function assertPublicHttpUrl(
  rawUrl: string,
  lookupFn: DnsLookupFn = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed (got ${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(`Blocked host: ${url.hostname}`);
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`Blocked private address: ${host}`);
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookupFn(host);
  } catch {
    throw new Error(`DNS lookup failed for ${host}.`);
  }
  if (addresses.length === 0) throw new Error(`DNS lookup returned no addresses for ${host}.`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Blocked host resolving to a private address: ${host}`);
    }
  }
  return url;
}

// ============ text extraction ============

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number(code);
      return Number.isFinite(point) && point > 0 && point < 0x110000
        ? String.fromCodePoint(point)
        : " ";
    });
}

export function extractTextFromHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = withoutBlocks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// ============ web tools ============

export type FetchUrlOptions = {
  fetchImpl?: typeof fetch;
  lookupFn?: DnsLookupFn;
  timeoutMs?: number;
};

export async function fetchUrlForOracle(
  rawUrl: string,
  options: FetchUrlOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let url = await assertPublicHttpUrl(rawUrl, options.lookupFn);
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_URL_TIMEOUT_MS),
      headers: {
        "user-agent": "beasty-arr-dub-oracle/1.0",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect without Location from ${url.hostname}.`);
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects.");
      // Every redirect hop goes through the SSRF guard again.
      url = await assertPublicHttpUrl(new URL(location, url).href, options.lookupFn);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.hostname}.`);
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const looksLikeHtml = /html|xml/i.test(contentType) || /^\s*</.test(body);
    const text = (looksLikeHtml ? extractTextFromHtml(body) : body).trim();
    if (!text) throw new Error(`Empty document from ${url.hostname}.`);
    return text.length > FETCH_URL_MAX_TEXT_CHARS
      ? `${text.slice(0, FETCH_URL_MAX_TEXT_CHARS)}\n[truncated]`
      : text;
  }
}

type WebEvidenceState = {
  fetchSucceeded: boolean;
  fetchedUrls: string[];
  fetchedPages: { url: string; text: string }[];
};

const PROVIDER_MENTION_RE =
  /\bnetflix\b|\bprime video\b|\bamazon video\b|\bdisney\+\b|\bapple tv\b|\bmax\b|\bwow\b|\bsky\b/i;
const PROVIDER_AVAILABILITY_RE =
  /(?:\bavailable\b|\bverfügbar\b|\bstream(?:ing|en)?\b|\bwatch\b|\bansehen\b|\bläuft\b|\bangeboten\b|\bsubscription\b|\babo\b).{0,100}(?:\bnetflix\b|\bprime video\b|\bamazon video\b|\bdisney\+\b|\bapple tv\b|\bmax\b|\bwow\b|\bsky\b)|(?:\bnetflix\b|\bprime video\b|\bamazon video\b|\bdisney\+\b|\bapple tv\b|\bmax\b|\bwow\b|\bsky\b).{0,100}(?:\bavailable\b|\bverfügbar\b|\bstream(?:ing|en)?\b|\bwatch\b|\bansehen\b|\bläuft\b|\bangeboten\b|\bsubscription\b|\babo\b)/i;
const NEGATED_PROVIDER_AVAILABILITY_RE =
  /(?:\bnot\b|\bno\b|\bunavailable\b|\bnicht\b|\bkein(?:e|en|er|es)?\b|\bohne\b).{0,40}(?:\bavailable\b|\bverfügbar\b|\bstream(?:ing|en)?\b|\bwatch\b|\bansehen\b|\bläuft\b|\bangeboten\b).{0,80}(?:\bnetflix\b|\bprime video\b|\bamazon video\b|\bdisney\+\b|\bapple tv\b|\bmax\b|\bwow\b|\bsky\b)|(?:\bnetflix\b|\bprime video\b|\bamazon video\b|\bdisney\+\b|\bapple tv\b|\bmax\b|\bwow\b|\bsky\b).{0,40}(?:\bnot\b|\bno\b|\bunavailable\b|\bnicht\b|\bkein(?:e|en|er|es)?\b|\bohne\b).{0,40}(?:\bavailable\b|\bverfügbar\b|\bstream(?:ing|en)?\b|\bwatch\b|\bansehen\b|\bläuft\b|\bangeboten\b)/i;

/** Model evidence must make an affirmative availability claim; provider filter/navigation text is insufficient. */
export function evidenceClaimsProviderAvailability(evidence: string[]): boolean {
  return evidence.some(
    (item) =>
      PROVIDER_MENTION_RE.test(item) &&
      PROVIDER_AVAILABILITY_RE.test(item) &&
      !NEGATED_PROVIDER_AVAILABILITY_RE.test(item),
  );
}

/** Search/browse pages do not qualify: the URL must identify one provider title. */
export function isOfficialProviderTitleUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "netflix.com" || host.endsWith(".netflix.com")) {
    return /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/\d+/.test(path);
  }
  if (host === "primevideo.com" || host.endsWith(".primevideo.com")) {
    return path.includes("/detail/");
  }
  if (host.startsWith("amazon.") || host.includes(".amazon.")) {
    return path.includes("/gp/video/detail/") || path.includes("/detail/");
  }
  if (host === "disneyplus.com" || host.endsWith(".disneyplus.com")) {
    return (
      path.includes("/browse/entity-") || path.includes("/movies/") || path.includes("/series/")
    );
  }
  if (host === "tv.apple.com" || host.endsWith(".tv.apple.com")) {
    return path.includes("/movie/") || path.includes("/show/");
  }
  if (host === "play.max.com" || host.endsWith(".play.max.com")) {
    return path.includes("/movie/") || path.includes("/show/");
  }
  return false;
}

/** Exact German aggregator title pages may expose a structured audio-language section. */
export function isGermanAggregatorTitleUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "justwatch.com" || host.endsWith(".justwatch.com")) {
    return JUSTWATCH_GERMAN_TITLE_PATH_RE.test(path);
  }
  if (host === "fernsehserien.de" || host.endsWith(".fernsehserien.de")) {
    const canonicalPath = path.endsWith("/") ? path.slice(0, -1) : path;
    return (
      FERNSEHSERIEN_MOVIE_PATH_RE.test(path) ||
      FERNSEHSERIEN_SEASON_PATH_RE.test(path) ||
      (FERNSEHSERIEN_SERIES_PATH_RE.test(path) && !FERNSEHSERIEN_RESERVED_PATHS.has(canonicalPath))
    );
  }
  return false;
}

/** Inspect only the provider's Audio section, never subtitles or page locale. */
export function providerPageListsGermanAudio(text: string): boolean {
  // Fernsehserien.de labels audio as `de (Sprache: Deutsch)` and subtitles as
  // `UT de (Untertitel: Deutsch)`, so this token is unambiguous on an exact title page.
  if (FERNSEHSERIEN_GERMAN_AUDIO_RE.test(text)) return true;
  const start = text.search(/(?:^|\n)\s*(?:Audio|Audiosprachen|Tonspuren?)\s*(?:\n|$)/i);
  if (start < 0) return false;
  const tail = text.slice(start, start + 2_500);
  const end = tail.search(
    /\n\s*(?:Subtitles|Untertitel|Cast|Besetzung|Genres|More Details|Weitere Details)\s*(?:\n|$)/i,
  );
  const audio = end > 0 ? tail.slice(0, end) : tail;
  return /\b(?:Deutsch|German|Deutsch(?:land)?)\b/i.test(audio);
}

function createFetchUrlTool(state: WebEvidenceState, options: FetchUrlOptions) {
  return defineTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch a public http(s) web page and return its extracted text (capped at 100 kB). Use it to verify German dub availability on the curated sources.",
    parameters: Type.Object({
      url: Type.String({ minLength: 10, description: "Absolute http(s) URL to fetch." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const text = await fetchUrlForOracle(params.url, options);
        state.fetchSucceeded = true;
        if (!state.fetchedUrls.includes(params.url)) state.fetchedUrls.push(params.url);
        const previous = state.fetchedPages.find((page) => page.url === params.url);
        if (previous) previous.text = text;
        else state.fetchedPages.push({ url: params.url, text });
        return {
          content: [{ type: "text" as const, text }],
          details: { url: params.url, ok: true },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `fetch_url failed: ${message}` }],
          details: { url: params.url, ok: false },
        };
      }
    },
  });
}

function createSearchTool(searxngUrl: string, options: FetchUrlOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return defineTool({
    name: "search_web",
    label: "Web Search",
    description:
      "Search the web (SearXNG) for German dub information. Returns the top results as title, URL and snippet.",
    parameters: Type.Object({
      query: Type.String({
        minLength: 2,
        description: "Search query, e.g. '<title> deutsche Synchronfassung'.",
      }),
    }),
    async execute(_toolCallId, params) {
      try {
        const endpoint = new URL("/search", searxngUrl);
        endpoint.searchParams.set("q", params.query);
        endpoint.searchParams.set("format", "json");
        const response = await fetchImpl(endpoint.href, {
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Search failed (HTTP ${response.status}).`);
        const data = (await response.json()) as {
          results?: Array<{ title?: string; url?: string; content?: string }>;
        };
        const lines = (data.results ?? [])
          .slice(0, 8)
          .map(
            (entry) =>
              `${entry.title ?? "(untitled)"} — ${entry.url ?? ""}\n${entry.content ?? ""}`,
          )
          .join("\n\n");
        return {
          content: [{ type: "text" as const, text: lines || "No results." }],
          details: { query: params.query },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `search_web failed: ${message}` }],
          details: { query: params.query },
        };
      }
    },
  });
}

// ============ terminating verdict tool ============

const verdictSchema = Type.Union([
  Type.Literal("exists"),
  Type.Literal("announced"),
  Type.Literal("unlikely"),
  Type.Literal("unknown"),
]);

export type RawDubVerdict = {
  verdict: AiVerdictValue;
  confidence: number;
  germanTitle?: string;
  perSeason?: {
    season: number;
    verdict: AiVerdictValue;
    confidence: number;
    note?: string;
    evidence: string[];
    expectedAvailability?: string;
    recheckAfterDays: number;
  }[];
  evidence: string[];
  expectedAvailability?: string;
  recheckAfterDays: number;
};

function createReportTool(
  capture: (verdict: RawDubVerdict) => void,
  requiredSeasons: number[] = [],
) {
  const seasonResults = Type.Array(
    Type.Object({
      season: Type.Integer({ minimum: 0 }),
      verdict: verdictSchema,
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      note: Type.Optional(Type.String()),
      evidence: Type.Array(Type.String()),
      expectedAvailability: Type.Optional(Type.String()),
      recheckAfterDays: Type.Integer({ minimum: 1 }),
    }),
    {
      minItems: requiredSeasons.length || undefined,
      maxItems: requiredSeasons.length || undefined,
      description: requiredSeasons.length
        ? `Required series results: exactly one entry for each requested season (${requiredSeasons.join(", ")}).`
        : "Optional season-specific results for a movie request.",
    },
  );
  return defineTool({
    name: REPORT_TOOL_NAME,
    label: "Report Dub Verdict",
    description:
      "Return the final typed German-dub verdict. This is the only tool that decides the outcome — call it exactly once to finish.",
    promptSnippet: "Return the final typed German-dub verdict.",
    promptGuidelines: [
      `Always finish by calling ${REPORT_TOOL_NAME} exactly once.`,
      "Verify against fetched web sources; do not rely on memory alone.",
    ],
    parameters: Type.Object({
      verdict: verdictSchema,
      confidence: Type.Number({ minimum: 0, maximum: 1, description: "Confidence from 0 to 1." }),
      germanTitle: Type.Optional(
        Type.String({ description: "Official German release title, when one exists." }),
      ),
      perSeason: requiredSeasons.length ? seasonResults : Type.Optional(seasonResults),
      evidence: Type.Array(Type.String(), {
        description: "Short evidence bullets citing what was found, including source URLs.",
      }),
      expectedAvailability: Type.Optional(
        Type.String({
          description:
            "ISO date (YYYY-MM-DD) when hunting should resume; required for announced when any date or release window is known. Convert an approximate month, quarter, or season to the first day of that window and say it is approximate in evidence.",
        }),
      ),
      recheckAfterDays: Type.Integer({
        minimum: 1,
        description: "Days until this verdict should be re-verified (90–730).",
      }),
    }),
    async execute(_toolCallId, params) {
      capture(params as RawDubVerdict);
      return {
        content: [{ type: "text" as const, text: "Dub verdict recorded." }],
        details: params,
        terminate: true,
      };
    },
  });
}

// ============ session builder ============

export type DubCheckSubject = {
  kind: "series" | "movie";
  title: string;
  year?: number | null;
  originalTitle?: string | null;
  originalLanguage?: string | null;
  externalIds: { tvdbId?: number | null; tmdbId?: number | null; imdbId?: string | null };
  seasons?: number[];
  confirmedGermanSeasons?: number[];
  catalogEvidence?: { source: string; url: string };
};

export type DubCheckSessionOptions = {
  searxngUrl?: string;
  fetchImpl?: typeof fetch;
  lookupFn?: DnsLookupFn;
};

export type DubCheckSession = {
  system: string;
  prompt: string;
  tools: ToolDefinition[];
  terminatingTool: typeof REPORT_TOOL_NAME;
  getVerdict(): RawDubVerdict | undefined;
  fetchSucceeded(): boolean;
  fetchedUrls(): string[];
  fetchedOfficialProviderTitle(): boolean;
  providerAvailabilityDetected(evidence: string[]): boolean;
  titlePageHasGermanAudio(): boolean;
};

const SYSTEM_PROMPT = [
  'You are the "Dub Oracle" for a German media library.',
  "Determine whether an official GERMAN AUDIO DUB exists or is announced. Research with the tools; memory alone is never evidence.",
  "<source_priority>",
  "- Deutsche Synchronkartei (https://www.synchronkartei.de — authoritative for German dubs; search via https://www.synchronkartei.de/suche?q=...)",
  "- The exact official streaming-provider title page (Netflix /title/<id>, Prime Video /detail/<id>, Disney+, Apple TV, Max)",
  "- JustWatch Germany (https://www.justwatch.com/de/...)",
  "- German Wikipedia (https://de.wikipedia.org)",
  "- Fernsehserien.de (https://www.fernsehserien.de)",
  "</source_priority>",
  "<research_contract>",
  "1. Match the exact work using year, original title and external IDs.",
  "2. Fetch the exact Deutsche Synchronkartei result/entry.",
  "3. If any source says the work is on a streaming provider, use search_web with the exact title and year to locate the provider's exact title-detail URL, then fetch it. Provider search, browse, login, press/media, and guessed-ID pages do not count.",
  "4. Confirm that the fetched provider page heading/metadata matches this exact work before using it. For Netflix, prefer a matching netflix.com/de/title/<id> result from web search over Netflix's internal search page.",
  "5. Read the Audio section. Keep Audio and Subtitles strictly separate. Exact JustWatch Germany and Fernsehserien.de title pages may corroborate structured audio languages when the provider page is inaccessible.",
  "6. Only then decide. Every evidence URL must have been opened successfully with fetch_url during this check.",
  "</research_contract>",
  "<verdicts>",
  "- exists: a German dub is released/available.",
  "- announced: a German dub or German release is officially announced or dated but not yet available.",
  "- unlikely: after useful web research, no German-dub evidence exists. This is the normal negative and sleeps for one year.",
  "- unknown: the work identity is genuinely unclear, fetched sources directly conflict, or no useful source could be fetched. A provider page being inaccessible is NOT by itself a reason for unknown.",
  "</verdicts>",
  "A German title, German availability/date, German subtitles, CC, or German audio description does NOT prove a German dub.",
  "Positive proof must explicitly say German in the Audio section or identify a German voice cast, dubbing studio, or synchronization.",
  "The exact provider Audio list outranks aggregators and a missing Synchronkartei entry.",
  "On an exact Fernsehserien.de title page, `de (Sprache: Deutsch)` in Streaming & Mediatheken proves German audio; `UT de (Untertitel: Deutsch)` proves only subtitles. An original-premiere label such as `Netflix (Englisch)` does not override a current `de (Sprache: Deutsch)` audio listing.",
  "If German listings explicitly show only original-language Audio plus German subtitles, return unlikely, not unknown.",
  "If the work is unavailable in Germany and no German-dub announcement or evidence exists, return unlikely, not unknown.",
  "For a German production, an official German broadcaster/distributor page or an explicitly documented deutsche Fassung/voice-over proves exists even when Synchronkartei has no entry. A German title alone is still insufficient.",
  "If the official source says No Dialogue, return exists: no language replacement is needed.",
  "A concert/performance film counts as exists without a dub only when fetched sources show that it consists almost entirely of music and has no meaningful translatable spoken content.",
  "Do NOT apply the concert exception to TV specials containing interviews, audience questions, answers, hosting, comedy, or substantial stage banter. Those require normal German-audio proof; stand-up comedy never qualifies.",
  "<series_contract>",
  "For a series, return exactly one perSeason entry for EVERY requested season, even when all seasons are unlikely.",
  "One series-level research pass may support multiple seasons, but each season still needs an explicit verdict, confidence, evidence, and recheck interval.",
  "A season in confirmedGermanSeasons is exists with confidence 1 because one downloaded German episode proves that complete season's dub.",
  "Never infer other seasons from a confirmed season. Do not omit, duplicate, or add seasons.",
  "</series_contract>",
  "confidence is 0..1. Report a confidence above 0.6 only when a fetched source confirms the verdict.",
  "evidence: short bullets citing what you found, each including its source URL.",
  "expectedAvailability: for announced, return the ISO date (YYYY-MM-DD) when hunting should resume whenever any date or release window is known.",
  "Convert approximate windows to their first plausible day: month → day 01; Q1/Q2/Q3/Q4 → Jan/Apr/Jul/Oct 01; spring/summer/autumn/winter → Mar/Jun/Sep/Dec 01. State that this conversion is approximate in evidence.",
  "recheckAfterDays: when to re-verify this verdict (90–730 days; long-running niche titles that will never get a dub → larger).",
  `Finish by calling ${REPORT_TOOL_NAME} exactly once.`,
].join("\n");

export function buildDubCheckSession(
  subject: DubCheckSubject,
  options: DubCheckSessionOptions = {},
): DubCheckSession {
  const state: WebEvidenceState = { fetchSucceeded: false, fetchedUrls: [], fetchedPages: [] };
  let captured: RawDubVerdict | undefined;
  const fetchOptions: FetchUrlOptions = {
    fetchImpl: options.fetchImpl,
    lookupFn: options.lookupFn,
  };
  const tools: ToolDefinition[] = [
    createFetchUrlTool(state, fetchOptions),
    ...(options.searxngUrl ? [createSearchTool(options.searxngUrl, fetchOptions)] : []),
    createReportTool(
      (verdict) => {
        captured = verdict;
      },
      subject.kind === "series" ? (subject.seasons ?? []) : [],
    ),
  ];

  const prompt = `Determine whether an official German dub exists for this ${subject.kind}:

${JSON.stringify(
  {
    kind: subject.kind,
    title: subject.title,
    year: subject.year ?? undefined,
    originalTitle: subject.originalTitle ?? undefined,
    originalLanguage: subject.originalLanguage ?? undefined,
    externalIds: subject.externalIds,
    seasons: subject.seasons?.length ? subject.seasons : undefined,
    confirmedGermanSeasons: subject.confirmedGermanSeasons?.length
      ? subject.confirmedGermanSeasons
      : undefined,
    catalogEvidence: subject.catalogEvidence,
  },
  null,
  2,
)}

Instructions:
- Verify on the preferred German sources via fetch_url${options.searxngUrl ? " (use search_web first when you need to locate the right page)" : ""}.
- Use the external ids (TVDB/TMDB/IMDb) and the original title to avoid confusing similarly named titles.
${
  subject.kind === "series"
    ? `- Return exactly one perSeason entry for every requested season: ${subject.seasons?.join(", ") || "none"}.
- Apply confirmedGermanSeasons directly as exists/confidence 1, then research all other requested seasons.
`
    : ""
}- Prefer every discovered provider's exact title-detail Audio section. If it is inaccessible, decide from the other successfully fetched German sources; do not choose unknown solely because that provider page failed.
- If Netflix is discovered, search the public web for the exact matching netflix.com/de/title/<id> page instead of stopping at Netflix search/login or media pages.
- Then call ${REPORT_TOOL_NAME} exactly once with your verdict.`;

  return {
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    terminatingTool: REPORT_TOOL_NAME,
    getVerdict: () => captured,
    fetchSucceeded: () => state.fetchSucceeded,
    fetchedUrls: () => [...state.fetchedUrls],
    fetchedOfficialProviderTitle: () =>
      state.fetchedPages.some((page) => isOfficialProviderTitleUrl(page.url)),
    providerAvailabilityDetected: (evidence) => evidenceClaimsProviderAvailability(evidence),
    titlePageHasGermanAudio: () =>
      state.fetchedPages.some(
        (page) =>
          (isOfficialProviderTitleUrl(page.url) || isGermanAggregatorTitleUrl(page.url)) &&
          providerPageListsGermanAudio(page.text),
      ),
  };
}

// ============ post-processing ============

export type FinalDubVerdict = {
  verdict: AiVerdictValue;
  confidence: number;
  germanTitle: string | null;
  perSeason:
    | {
        season: number;
        verdict: AiVerdictValue;
        confidence: number;
        note?: string;
        evidence: string[];
        expectedAvailability: number | null;
        recheckAfterDays: number;
      }[]
    | null;
  evidence: string[];
  /** Epoch ms, parsed from the ISO date; null when absent or unparseable. */
  expectedAvailability: number | null;
  recheckAfterDays: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isVerdictValue(value: unknown): value is AiVerdictValue {
  return typeof value === "string" && (AI_VERDICTS as readonly string[]).includes(value);
}

/**
 * Clamp and sanitize the raw tool output. A missing verdict (terminating tool
 * never called, even after the runner's re-prompt) degrades to unknown/0.
 */
export function finalizeDubVerdict(
  raw: RawDubVerdict | undefined,
  fetchSucceeded: boolean,
): FinalDubVerdict {
  if (!raw || !isVerdictValue(raw.verdict)) {
    return {
      verdict: "unknown",
      confidence: 0,
      germanTitle: null,
      perSeason: null,
      evidence: raw
        ? ["The model returned an invalid verdict."]
        : ["The model did not produce a verdict."],
      expectedAvailability: null,
      recheckAfterDays: RECHECK_MIN_DAYS,
    };
  }
  let confidence = Number.isFinite(raw.confidence) ? clamp(raw.confidence, 0, 1) : 0;
  if (!fetchSucceeded) confidence = Math.min(confidence, KNOWLEDGE_ONLY_CONFIDENCE_CAP);
  const recheckAfterDays = Number.isFinite(raw.recheckAfterDays)
    ? Math.round(clamp(raw.recheckAfterDays, RECHECK_MIN_DAYS, RECHECK_MAX_DAYS))
    : RECHECK_MIN_DAYS;
  const perSeason = Array.isArray(raw.perSeason)
    ? raw.perSeason
        .filter((entry) => Number.isInteger(entry?.season) && isVerdictValue(entry?.verdict))
        .map((entry) => {
          let seasonConfidence = Number.isFinite(entry.confidence)
            ? clamp(entry.confidence, 0, 1)
            : 0;
          if (!fetchSucceeded) {
            seasonConfidence = Math.min(seasonConfidence, KNOWLEDGE_ONLY_CONFIDENCE_CAP);
          }
          const parsedAvailability =
            typeof entry.expectedAvailability === "string"
              ? Date.parse(entry.expectedAvailability)
              : Number.NaN;
          return {
            season: entry.season,
            verdict: entry.verdict,
            confidence: seasonConfidence,
            ...(typeof entry.note === "string" && entry.note.trim() ? { note: entry.note } : {}),
            evidence: Array.isArray(entry.evidence)
              ? entry.evidence.filter((value): value is string => typeof value === "string")
              : [],
            expectedAvailability: Number.isFinite(parsedAvailability) ? parsedAvailability : null,
            recheckAfterDays: Number.isFinite(entry.recheckAfterDays)
              ? Math.round(clamp(entry.recheckAfterDays, RECHECK_MIN_DAYS, RECHECK_MAX_DAYS))
              : RECHECK_MIN_DAYS,
          };
        })
    : null;
  const expectedAvailability =
    typeof raw.expectedAvailability === "string" && raw.expectedAvailability.trim()
      ? Date.parse(raw.expectedAvailability)
      : Number.NaN;
  return {
    verdict: raw.verdict,
    confidence,
    germanTitle:
      typeof raw.germanTitle === "string" && raw.germanTitle.trim() ? raw.germanTitle : null,
    perSeason: perSeason?.length ? perSeason : null,
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.filter((entry): entry is string => typeof entry === "string")
      : [],
    expectedAvailability: Number.isFinite(expectedAvailability) ? expectedAvailability : null,
    recheckAfterDays,
  };
}
