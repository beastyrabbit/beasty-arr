/**
 * Read-only inspection of the real media files behind an arr path. The fixer
 * uses it to establish what a download actually is instead of trusting the
 * arr's parse of the release name.
 */

export interface ProbeStream {
  /** ffprobe stream index. */
  index: number;
  codec?: string;
  /** Raw language tag from the container (e.g. "ger", "eng", "und"). */
  language?: string;
  /** Stream title tag (often "German", "Deutsch DD5.1", "English SDH"). */
  title?: string;
  /** ISO 639-2 language from the tag, or inferred from the title when the tag is empty/und. */
  inferredLanguage?: string;
  isDefault?: boolean;
  isForced?: boolean;
}

export interface ProbeAudioStream extends ProbeStream {
  channels?: number;
}

export interface ProbeSubtitleStream extends ProbeStream {
  /** Text subtitles (srt/ass/webvtt/mov_text) can be excerpted; image subtitles (pgs/vobsub) cannot. */
  textBased: boolean;
}

export interface ProbeFolderEntry {
  name: string;
  sizeBytes: number;
  isDirectory: boolean;
}

export interface ProbeNfo {
  name: string;
  imdbIds: string[];
  tmdbIds: string[];
  tvdbIds: string[];
  /** First characters of the NFO, whitespace-collapsed. */
  excerpt: string;
}

export interface MediaProbeOk {
  ok: true;
  /** The arr-side path that was requested. */
  path: string;
  sizeBytes: number;
  durationSeconds?: number;
  /** Container-level title tag; frequently names the actual work or episode. */
  containerTitle?: string;
  video?: { codec?: string; width?: number; height?: number; hdr?: string };
  audio: ProbeAudioStream[];
  subtitles: ProbeSubtitleStream[];
  chapters: { count: number; titles: string[] };
  /** True when any audio stream's inferred language is German. */
  hasGermanAudio: boolean;
  /** Distinct inferred audio languages, in stream order. */
  audioLanguages: string[];
  /** Dialogue lines from the start of the best text subtitle stream (eng, then ger, then any). */
  subtitleExcerpt?: { streamIndex: number; language?: string; lines: string[] };
  /** Listing of the directory containing the file. */
  folder?: { entries: ProbeFolderEntry[]; truncated: boolean };
  nfos?: ProbeNfo[];
}

export interface MediaProbeFailure {
  ok: false;
  path: string;
  reason: string;
}

export type MediaProbeResult = MediaProbeOk | MediaProbeFailure;

export interface MediaProbeOptions {
  /** Extract dialogue lines from a text subtitle stream (slower: reads the start of the file). */
  subtitleExcerpt?: boolean;
  /** List the containing folder and read NFO files in it. */
  folder?: boolean;
}

export interface MediaProber {
  /** False when no path mapping is configured; probe() then always fails with a reason. */
  readonly available: boolean;
  probe(arrPath: string, options?: MediaProbeOptions): Promise<MediaProbeResult>;
}
