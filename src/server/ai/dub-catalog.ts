import type { OracleCheckSubject } from "./oracle-service.js";

const WDQS_URL = "https://query.wikidata.org/sparql";
const BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const IMDB_ID_RE = /^tt\d{5,12}$/;
const NUMERIC_ID_RE = /^\d+$/;

export type DubCatalogEvidence = {
  subjectKey: string;
  source: "wikidata-synchronkartei";
  sourceId: string;
  url: string;
};

export type DubCatalogLookupResult = {
  evidence: Map<string, DubCatalogEvidence>;
  checkedSubjectKeys: Set<string>;
  failures: { subjectKeys: string[]; error: string }[];
};

type SparqlBinding = Record<string, { value?: string } | undefined>;

function literal(value: string): string {
  return JSON.stringify(value);
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function validImdb(value: string | undefined): value is string {
  return Boolean(value && IMDB_ID_RE.test(value));
}

function subjectQuery(subjects: OracleCheckSubject[]): string {
  const imdb = [...new Set(subjects.map((s) => s.externalIds.imdbId).filter(validImdb))];
  const tvdb = [
    ...new Set(
      subjects
        .map((s) => s.externalIds.tvdbId)
        .filter((id): id is number => id != null && Number.isInteger(id) && id > 0)
        .map(String),
    ),
  ];
  const tmdb = [
    ...new Set(
      subjects
        .map((s) => s.externalIds.tmdbId)
        .filter((id): id is number => id != null && Number.isInteger(id) && id > 0)
        .map(String),
    ),
  ];
  const branches: string[] = [];
  if (imdb.length) {
    branches.push(`{ VALUES ?imdb { ${imdb.map(literal).join(" ")} } ?item wdt:P345 ?imdb. }`);
  }
  if (tvdb.length) {
    branches.push(`{ VALUES ?tvdb { ${tvdb.map(literal).join(" ")} } ?item wdt:P4835 ?tvdb. }`);
  }
  if (tmdb.length) {
    branches.push(`{ VALUES ?tmdb { ${tmdb.map(literal).join(" ")} } ?item wdt:P4947 ?tmdb. }`);
  }
  return `SELECT DISTINCT ?imdb ?tvdb ?tmdb ?filmDub ?seriesDub WHERE {
    ${branches.join(" UNION ")}
    OPTIONAL { ?item wdt:P345 ?imdb. }
    OPTIONAL { ?item wdt:P4835 ?tvdb. }
    OPTIONAL { ?item wdt:P4947 ?tmdb. }
    OPTIONAL { ?item wdt:P3844 ?filmDub. }
    OPTIONAL { ?item wdt:P4834 ?seriesDub. }
    FILTER(BOUND(?filmDub) || BOUND(?seriesDub))
  }`;
}

async function fetchBatch(
  batch: OracleCheckSubject[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ results?: { bindings?: SparqlBinding[] } }> {
  const response = await fetchImpl(WDQS_URL, {
    method: "POST",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      accept: "application/sparql-results+json",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "beasty-arr/0.3 (German dub catalog prefilter)",
    },
    body: new URLSearchParams({ query: subjectQuery(batch) }),
  });
  if (!response.ok) throw new Error(`Wikidata dub catalog returned HTTP ${response.status}.`);
  return (await response.json()) as { results?: { bindings?: SparqlBinding[] } };
}

function evidenceFromBinding(
  batch: OracleCheckSubject[],
  binding: SparqlBinding,
): DubCatalogEvidence | null {
  const imdb = binding.imdb?.value;
  const tvdb = binding.tvdb?.value;
  const tmdb = binding.tmdb?.value;
  const subject = batch.find(
    (candidate) =>
      (imdb && candidate.externalIds.imdbId === imdb) ||
      (tvdb && String(candidate.externalIds.tvdbId ?? "") === tvdb) ||
      (tmdb && String(candidate.externalIds.tmdbId ?? "") === tmdb),
  );
  if (!subject) return null;
  const sourceId =
    subject.subjectKind === "movie" ? binding.filmDub?.value : binding.seriesDub?.value;
  if (!sourceId || !NUMERIC_ID_RE.test(sourceId)) return null;
  const kind = subject.subjectKind === "movie" ? "film" : "serie";
  return {
    subjectKey: subject.subjectKey,
    source: "wikidata-synchronkartei",
    sourceId,
    url: `https://www.synchronkartei.de/${kind}/${sourceId}`,
  };
}

/**
 * Batch-match library IDs against Wikidata's CC0 Synchronkartei identifiers.
 * A film identifier confirms a German film dub. A series identifier is only a
 * series-level positive signal; season coverage remains an oracle decision.
 */
export async function lookupDubCatalog(
  subjects: OracleCheckSubject[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<DubCatalogLookupResult> {
  const evidence = new Map<string, DubCatalogEvidence>();
  const checkedSubjectKeys = new Set<string>();
  const failures: DubCatalogLookupResult["failures"] = [];
  for (const batch of chunks(subjects, BATCH_SIZE)) {
    if (!batch.some((s) => s.externalIds.imdbId || s.externalIds.tvdbId || s.externalIds.tmdbId)) {
      for (const subject of batch) checkedSubjectKeys.add(subject.subjectKey);
      continue;
    }
    let payload: { results?: { bindings?: SparqlBinding[] } };
    try {
      payload = await fetchBatch(batch, fetchImpl, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push({
        subjectKeys: batch.map((subject) => subject.subjectKey),
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const subject of batch) checkedSubjectKeys.add(subject.subjectKey);
    for (const binding of payload.results?.bindings ?? []) {
      const match = evidenceFromBinding(batch, binding);
      if (match) evidence.set(match.subjectKey, match);
    }
  }
  return { evidence, checkedSubjectKeys, failures };
}
