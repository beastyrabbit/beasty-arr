import type { ManualImportCandidate, MediaService, QueueItem } from "../../shared/fixer-types.js";
import type { ArrMediaInfo } from "../arr/http-util.js";
import type { RadarrClient, RadarrMovieRecord } from "../arr/radarr-client.js";
import { isDiscStreamPath } from "../arr/sample.js";
import type { SonarrClient, SonarrEpisodeRecord } from "../arr/sonarr-client.js";
import type { MediaProbeResult, MediaProber, ProbeSubtitleStream } from "../media/types.js";

/**
 * Facts the fixer collects itself before and during an analysis, independent
 * of the arr's grab-history mapping. The prompt shows them to the AI and the
 * deterministic guards (guards.ts) check proposals against them.
 */
export interface InspectionFacts {
  service: MediaService;
  proberAvailable: boolean;
  /** Probe results keyed by arr path (candidates and current library files). */
  probes: Map<string, MediaProbeResult>;
  /** The arr's parse of the release name on its own, without grab history. */
  parse?: IndependentParse;
  /** Queued movie or target episodes, keyed by movie id / episode id. */
  targets: Map<number, TargetFacts>;
}

export interface IndependentParse {
  releaseTitle: string;
  parsedTitle?: string;
  parsedYear?: number;
  parsedSeason?: number;
  parsedEpisodes?: number[];
  /** Movie/series id the arr resolved the name to, if any. */
  matchedId?: number;
  matchedTitle?: string;
  /** Episode ids the arr resolved the name to (Sonarr). */
  matchedEpisodeIds: number[];
}

export interface TargetFacts {
  id: number;
  label: string;
  /** Movie release year, or the year an episode first aired. */
  year?: number;
  /** Runtime in minutes from TMDb/TVDB metadata. */
  expectedRuntimeMinutes?: number;
  currentFile?: {
    path?: string;
    quality?: string;
    languages: string[];
    mediaInfo?: ArrMediaInfo;
  };
}

export type RadarrInspectionClient = Pick<RadarrClient, "getMovie"> &
  Partial<Pick<RadarrClient, "parseRelease">>;
export type SonarrInspectionClient = Pick<SonarrClient, "getEpisodes"> &
  Partial<Pick<SonarrClient, "parseRelease">>;

const MAX_UPFRONT_PROBES = 30;
const PROBE_CONCURRENCY = 4;

function valueName(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const { name, id } = value as { name?: unknown; id?: unknown };
  if (typeof name === "string") return name;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

/** "Title (Year)" when the year is known. */
function titleWithYear(title: string, year: number | undefined): string {
  return year ? `${title} (${year})` : title;
}

function episodeCode(episode: SonarrEpisodeRecord): string {
  if (episode.seasonNumber === undefined || episode.episodeNumber === undefined) {
    return `episode ${episode.id}`;
  }
  const season = String(episode.seasonNumber).padStart(2, "0");
  const number = String(episode.episodeNumber).padStart(2, "0");
  return `S${season}E${number}`;
}

function qualityName(quality: unknown): string | undefined {
  const inner = (quality as { quality?: unknown } | undefined)?.quality ?? quality;
  return valueName(inner) || undefined;
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
  signal?: AbortSignal,
) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined && !signal?.aborted; item = queue.shift()) {
      await task(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Probes each path once per analysis; later calls reuse the stored result.
 * Stops starting new probes once `signal` aborts.
 */
export async function probePaths(
  facts: InspectionFacts,
  prober: MediaProber | undefined,
  paths: string[],
  options: { subtitleExcerpt?: boolean; folder?: boolean; signal?: AbortSignal } = {},
): Promise<MediaProbeResult[]> {
  const unique = [...new Set(paths.filter(Boolean))];
  const { signal, ...probeOptions } = options;
  await mapLimit(
    unique,
    PROBE_CONCURRENCY,
    (path) => probeOnce(facts, prober, path, probeOptions),
    signal,
  );
  return unique.map((path) => facts.probes.get(path) ?? { ok: false, path, reason: "Not probed." });
}

async function probeOnce(
  facts: InspectionFacts,
  prober: MediaProber | undefined,
  path: string,
  options: { subtitleExcerpt?: boolean; folder?: boolean },
): Promise<void> {
  const existing = facts.probes.get(path);
  const needsMore =
    existing?.ok &&
    ((options.subtitleExcerpt && !existing.subtitleExcerpt) ||
      (options.folder && !existing.folder));
  if (existing && !needsMore) return;
  const result: MediaProbeResult = prober
    ? await prober.probe(path, options).catch((error: unknown) => ({
        ok: false as const,
        path,
        reason: error instanceof Error ? error.message : String(error),
      }))
    : { ok: false, path, reason: "Media probing is not configured." };
  facts.probes.set(path, result);
}

function movieTarget(movie: RadarrMovieRecord): TargetFacts | undefined {
  if (!movie.id) return undefined;
  const file = movie.movieFile;
  return {
    id: movie.id,
    label: titleWithYear(movie.title ?? "movie", movie.year),
    year: movie.year,
    expectedRuntimeMinutes: movie.runtime || undefined,
    currentFile: file
      ? {
          path: file.path,
          quality: qualityName(file.quality),
          languages: (file.languages ?? []).map(valueName).filter(Boolean),
          mediaInfo: file.mediaInfo,
        }
      : undefined,
  };
}

function episodeTarget(episode: SonarrEpisodeRecord): TargetFacts | undefined {
  if (!episode.id) return undefined;
  const file = episode.episodeFile;
  return {
    id: episode.id,
    label: [episodeCode(episode), episode.title].filter(Boolean).join(" "),
    year: Number((episode.airDate ?? episode.airDateUtc)?.slice(0, 4)) || undefined,
    expectedRuntimeMinutes: episode.runtime || undefined,
    currentFile:
      episode.hasFile && file
        ? {
            path: file.path,
            quality: qualityName(file.quality),
            languages: (file.languages ?? []).map(valueName).filter(Boolean),
            mediaInfo: file.mediaInfo,
          }
        : undefined,
  };
}

function inspectableCandidates(candidates: ManualImportCandidate[]): ManualImportCandidate[] {
  return candidates
    .filter((candidate) => candidate.path && !isDiscStreamPath(candidate.path))
    .slice(0, MAX_UPFRONT_PROBES);
}

export function emptyFacts(
  service: MediaService,
  prober: MediaProber | undefined,
): InspectionFacts {
  return {
    service,
    proberAvailable: prober?.available ?? false,
    probes: new Map(),
    targets: new Map(),
  };
}

async function fetchTargets(
  service: MediaService,
  client: RadarrInspectionClient | SonarrInspectionClient,
  ids: number[],
): Promise<Array<TargetFacts | undefined>> {
  if (service === "radarr") {
    const movies = await Promise.all(
      ids.map((id) => (client as RadarrInspectionClient).getMovie(id).catch(() => undefined)),
    );
    return movies.map((movie) => movie && movieTarget(movie));
  }
  const episodes = await (client as SonarrInspectionClient)
    .getEpisodes({ episodeIds: ids, includeEpisodeFile: true })
    .catch(() => []);
  return episodes.map(episodeTarget);
}

/** Loads target movies/episodes into the facts; returns the targets that were found. */
export async function loadTargets(
  facts: InspectionFacts,
  client: RadarrInspectionClient | SonarrInspectionClient,
  ids: number[],
): Promise<TargetFacts[]> {
  const missing = [...new Set(ids)].filter((id) => id > 0 && !facts.targets.has(id));
  if (missing.length > 0) {
    for (const target of await fetchTargets(facts.service, client, missing)) {
      if (target) facts.targets.set(target.id, target);
    }
  }
  return ids.flatMap((id) => {
    const target = facts.targets.get(id);
    return target ? [target] : [];
  });
}

async function independentParse(
  service: MediaService,
  client: RadarrInspectionClient | SonarrInspectionClient,
  releaseTitle: string,
): Promise<IndependentParse | undefined> {
  if (!releaseTitle || !client.parseRelease) return undefined;
  try {
    if (service === "radarr") {
      const result = await (client as RadarrInspectionClient).parseRelease?.(releaseTitle);
      return {
        releaseTitle,
        parsedTitle: result?.parsedMovieInfo?.movieTitles?.[0],
        parsedYear: result?.parsedMovieInfo?.year || undefined,
        matchedId: result?.movie?.id,
        matchedTitle: result?.movie
          ? titleWithYear(result.movie.title ?? "", result.movie.year)
          : undefined,
        matchedEpisodeIds: [],
      };
    }
    const result = await (client as SonarrInspectionClient).parseRelease?.(releaseTitle);
    const info = result?.parsedEpisodeInfo;
    return {
      releaseTitle,
      parsedTitle: info?.seriesTitle,
      parsedYear: info?.seriesTitleInfo?.year || undefined,
      parsedSeason: info?.seasonNumber,
      parsedEpisodes: info?.episodeNumbers,
      matchedId: result?.series?.id,
      matchedTitle: result?.series?.title,
      matchedEpisodeIds: (result?.episodes ?? []).flatMap((episode) =>
        episode.id ? [episode.id] : [],
      ),
    };
  } catch {
    return undefined;
  }
}

/**
 * Collects the upfront facts: the queued targets with their current files and
 * expected runtimes, the arr's independent parse of the release name, and a
 * header probe of every candidate and current library file.
 */
export async function collectInspection(input: {
  queueItem: QueueItem;
  candidates: ManualImportCandidate[];
  client: RadarrInspectionClient | SonarrInspectionClient;
  prober: MediaProber | undefined;
}): Promise<InspectionFacts> {
  const { queueItem, candidates, client, prober } = input;
  const facts = emptyFacts(queueItem.service, prober);
  const targetIds =
    queueItem.service === "radarr"
      ? [queueItem.movieId ?? 0]
      : [...new Set([...queueItem.episodeIds, ...candidates.flatMap((c) => c.episodeIds)])];
  const [targets, parse] = await Promise.all([
    loadTargets(facts, client, targetIds),
    independentParse(queueItem.service, client, queueItem.title),
  ]);
  facts.parse = parse;
  await probePaths(facts, prober, [
    ...inspectableCandidates(candidates).map((candidate) => candidate.path),
    ...targets.flatMap((target) => (target.currentFile?.path ? [target.currentFile.path] : [])),
  ]);
  return facts;
}

// ============ prompt rendering ============

function minutes(seconds: number | undefined): string {
  return seconds === undefined ? "unknown" : `${Math.round(seconds / 60)} min`;
}

function resolutionLabel(probe: MediaProbeResult): string | undefined {
  if (!probe.ok || !probe.video?.height) return undefined;
  const size = `${probe.video.width ?? "?"}x${probe.video.height}`;
  return probe.video.hdr ? `${size} ${probe.video.hdr}` : size;
}

function subtitleLabel(stream: ProbeSubtitleStream): string {
  const parts = [stream.inferredLanguage ?? stream.language ?? "und"];
  if (stream.title) parts.push(`"${stream.title}"`);
  if (stream.isForced) parts.push("forced");
  if (!stream.textBased) parts.push("(image)");
  return parts.join(" ");
}

/** Compact, model-facing summary of one probe. */
export function summarizeProbe(probe: MediaProbeResult) {
  if (!probe.ok) return { path: probe.path, inspected: false, reason: probe.reason };
  return {
    path: probe.path,
    inspected: true,
    duration: minutes(probe.durationSeconds),
    containerTitle: probe.containerTitle,
    resolution: resolutionLabel(probe),
    videoCodec: probe.video?.codec,
    audio: probe.audio.map((stream) => ({
      language: stream.inferredLanguage ?? stream.language ?? "und",
      tag: stream.language,
      title: stream.title,
      codec: stream.codec,
      channels: stream.channels,
    })),
    hasGermanAudio: probe.hasGermanAudio,
    subtitles: probe.subtitles.map(subtitleLabel),
    chapters: probe.chapters.count ? probe.chapters : undefined,
    subtitleExcerpt: probe.subtitleExcerpt,
    folder: probe.folder,
    nfos: probe.nfos,
  };
}

export function renderInspection(
  facts: InspectionFacts,
  candidates: ManualImportCandidate[],
): string {
  const targets = [...facts.targets.values()].map((target) => ({
    id: target.id,
    label: target.label,
    expectedRuntime:
      target.expectedRuntimeMinutes !== undefined
        ? `${target.expectedRuntimeMinutes} min`
        : "unknown",
    currentFile: target.currentFile
      ? {
          path: target.currentFile.path,
          arrQuality: target.currentFile.quality,
          arrLanguages: target.currentFile.languages,
          inspected: target.currentFile.path
            ? summarizeProbe(
                facts.probes.get(target.currentFile.path) ?? {
                  ok: false,
                  path: target.currentFile.path,
                  reason: "Not probed.",
                },
              )
            : undefined,
        }
      : "none (the target has no library file)",
  }));
  const files = candidates.map((candidate) => ({
    candidateId: candidate.id,
    ...summarizeProbe(
      facts.probes.get(candidate.path) ?? {
        ok: false,
        path: candidate.path,
        reason: isDiscStreamPath(candidate.path) ? "Disc structure chunk." : "Not probed upfront.",
      },
    ),
  }));
  return JSON.stringify(
    {
      mediaInspection: facts.proberAvailable
        ? "available"
        : "NOT available: real files cannot be inspected; every import will wait for the user.",
      independentParse: facts.parse ?? "unavailable",
      targets,
      candidateFiles: files,
    },
    null,
    2,
  );
}
