/**
 * Read-only media prober: maps an arr-side path (e.g. /data/...) onto the
 * locally mounted media volume, refuses anything that escapes the mapped
 * root, and inspects the file with ffprobe (plus optional ffmpeg subtitle
 * excerpt and folder/NFO listing). Exec and filesystem access are injectable
 * so tests never spawn processes or touch real media. Nothing is ever written.
 */

import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  MediaProbeFailure,
  MediaProbeOk,
  MediaProbeOptions,
  MediaProbeResult,
  MediaProber,
  ProbeAudioStream,
  ProbeFolderEntry,
  ProbeNfo,
  ProbeSubtitleStream,
} from "./types.js";

export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface FsDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FsPort {
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<{ size: number; isFile(): boolean; isDirectory(): boolean }>;
  readdir(target: string): Promise<FsDirent[]>;
  /** Reads at most maxBytes from the start of the file as UTF-8. */
  readFileHead(target: string, maxBytes: number): Promise<string>;
}

export interface MediaPathMapping {
  from: string;
  to: string;
}

export interface MediaProberOptions {
  pathMap: MediaPathMapping[];
  exec?: ExecFn;
  fs?: FsPort;
  ffprobePath?: string;
  ffmpegPath?: string;
  /** ffprobe timeout. Default 30s. */
  timeoutMs?: number;
  /** ffmpeg subtitle-extraction timeout. Default 60s. */
  subtitleTimeoutMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
export const DEFAULT_SUBTITLE_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const SUBTITLE_EXCERPT_SECONDS = 1200;
const SUBTITLE_EXCERPT_LINES = 40;
const SUBTITLE_LINE_MAX_CHARS = 200;
const FOLDER_MAX_ENTRIES = 60;
const NFO_MAX_FILES = 3;
const NFO_MAX_BYTES = 16 * 1024;
const NFO_EXCERPT_CHARS = 400;
const CHAPTER_TITLE_LIMIT = 20;
const REASON_MAX_CHARS = 200;

const NOT_CONFIGURED_REASON = "Media probing is not configured (FIXER_MEDIA_PATH_MAP).";
const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);

const WHITESPACE_RE = /\s+/g;
const TITLE_TOKEN_RE = /[^\p{L}]+/u;
const ISO_639_2_RE = /^[a-z]{3}$/;
const LOCALE_SEPARATOR_RE = /[-_]/;
const LINE_BREAK_RE = /\r?\n/;
const SRT_COUNTER_RE = /^\d+$/;
const SRT_TIMESTAMP_RE = /-->/;
// Bounded and excluding the opening character, so unclosed tags cannot make
// stripping quadratic.
const SRT_HTML_TAG_RE = /<[^<>]{0,200}>/g;
const SRT_ASS_TAG_RE = /\{[^{}]{0,200}\}/g;
const SRT_ASS_ESCAPE_RE = /\\[Nnh]/g;
const IMDB_ID_RE = /tt\d{7,9}/g;
const TMDB_URL_RE = /themoviedb\.org\/(?:movie|tv)\/(\d+)/gi;
const TMDB_TAG_RE = /<(?:tmdbid|uniqueid[^>]*type="tmdb"[^>]*)>\s*(\d+)\s*</gi;
// series/<id> or series/<slug>/<id>; deeper numeric segments are season/episode ids.
const TVDB_SERIES_URL_RE =
  /thetvdb\.com\/(?:[^\s"'<>]*\/)?series\/(?:[^\s"'<>/?#]+\/)?(\d+)(?![^\s"'<>/?#])/gi;
const TVDB_QUERY_URL_RE = /thetvdb\.com\/[^\s"'<>]*?[?&](?:series)?id=(\d+)/gi;
const TVDB_LABEL_RE = /\btvdb[: ](\d+)/gi;
const TVDB_TAG_RE = /<(?:tvdbid|uniqueid[^>]*type="tvdb"[^>]*)>\s*(\d+)\s*</gi;

// ---------------------------------------------------------------------------
// Path mapping

function normalizeRoot(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/** Parses "FROM=TO[,FROM2=TO2]" (e.g. "/data=/arr-data"). Throws on invalid entries. */
export function parseMediaPathMap(value: string | undefined): MediaPathMapping[] {
  if (!value) {
    return [];
  }
  const mappings: MediaPathMapping[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry === "") {
      continue;
    }
    const separator = entry.indexOf("=");
    const from = separator === -1 ? "" : entry.slice(0, separator).trim();
    const to = separator === -1 ? "" : entry.slice(separator + 1).trim();
    if (!(from.startsWith("/") && to.startsWith("/")) || `${from}${to}`.includes("\0")) {
      throw new Error(
        `Invalid FIXER_MEDIA_PATH_MAP entry "${entry}": expected FROM=TO with absolute paths`,
      );
    }
    mappings.push({ from: normalizeRoot(from), to: normalizeRoot(to) });
  }
  return mappings;
}

type MappedPath = { ok: true; localPath: string; root: string } | { ok: false; reason: string };

function matchesPrefix(candidate: string, from: string): boolean {
  return from === "/" || candidate === from || candidate.startsWith(`${from}/`);
}

function mapArrPath(arrPath: string, pathMap: readonly MediaPathMapping[]): MappedPath {
  if (typeof arrPath !== "string" || arrPath === "") {
    return { ok: false, reason: "Path is empty." };
  }
  if (arrPath.includes("\0")) {
    return { ok: false, reason: "Path contains a NUL byte." };
  }
  if (!arrPath.startsWith("/")) {
    return { ok: false, reason: "Path must be absolute." };
  }
  if (arrPath.split("/").includes("..")) {
    return { ok: false, reason: "Path must not contain '..' segments." };
  }
  const normalized = normalizeRoot(arrPath);
  let best: MediaPathMapping | undefined;
  for (const mapping of pathMap) {
    if (
      matchesPrefix(normalized, mapping.from) &&
      (!best || mapping.from.length > best.from.length)
    ) {
      best = mapping;
    }
  }
  if (!best) {
    return { ok: false, reason: "Path is outside every configured media mapping." };
  }
  const rest = best.from === "/" ? normalized : normalized.slice(best.from.length);
  return { ok: true, localPath: path.posix.join(best.to, rest), root: best.to };
}

function isInside(target: string, root: string): boolean {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

// ---------------------------------------------------------------------------
// Language normalization

/** Canonical ISO 639-2/B code followed by its tag aliases and spelled-out names. */
const LANGUAGES: ReadonlyArray<{ code: string; codes: string[]; names: string[] }> = [
  { code: "ger", codes: ["ger", "deu", "de", "gsw"], names: ["german", "deutsch", "allemand"] },
  { code: "eng", codes: ["eng", "en"], names: ["english", "englisch", "anglais"] },
  { code: "jpn", codes: ["jpn", "ja", "jp"], names: ["japanese", "japanisch", "nihongo"] },
  {
    code: "fre",
    codes: ["fre", "fra", "fr"],
    names: ["french", "französisch", "francais", "français"],
  },
  {
    code: "spa",
    codes: ["spa", "es"],
    names: ["spanish", "spanisch", "español", "espanol", "castellano"],
  },
  { code: "ita", codes: ["ita", "it"], names: ["italian", "italienisch", "italiano"] },
  { code: "por", codes: ["por", "pt"], names: ["portuguese", "portugiesisch", "português"] },
  { code: "rus", codes: ["rus", "ru"], names: ["russian", "russisch"] },
  { code: "kor", codes: ["kor", "ko"], names: ["korean", "koreanisch"] },
  {
    code: "chi",
    codes: ["chi", "zho", "zh"],
    names: ["chinese", "chinesisch", "mandarin", "cantonese"],
  },
  { code: "dut", codes: ["dut", "nld", "nl"], names: ["dutch", "niederländisch", "nederlands"] },
  { code: "pol", codes: ["pol", "pl"], names: ["polish", "polnisch", "polski"] },
  { code: "tur", codes: ["tur", "tr"], names: ["turkish", "türkisch"] },
  { code: "swe", codes: ["swe", "sv"], names: ["swedish", "schwedisch", "svenska"] },
  { code: "nor", codes: ["nor", "nob", "nno", "no"], names: ["norwegian", "norwegisch", "norsk"] },
  { code: "dan", codes: ["dan", "da"], names: ["danish", "dänisch", "dansk"] },
  { code: "fin", codes: ["fin", "fi"], names: ["finnish", "finnisch", "suomi"] },
  { code: "cze", codes: ["cze", "ces", "cs"], names: ["czech", "tschechisch"] },
  { code: "hun", codes: ["hun", "hu"], names: ["hungarian", "ungarisch", "magyar"] },
  { code: "ara", codes: ["ara", "ar"], names: ["arabic", "arabisch"] },
  { code: "hin", codes: ["hin", "hi"], names: ["hindi"] },
  { code: "tha", codes: ["tha", "th"], names: ["thai"] },
];

const TAG_ALIASES = new Map<string, string>();
const TITLE_NAMES = new Map<string, string>();
/** Upper-case codes accepted as title words ("GER DD5.1"). Two-letter codes are kept to a safe set. */
const TITLE_CODES = new Map<string, string>();
const SAFE_TWO_LETTER_TITLE_CODES = new Set(["de", "en", "fr", "es", "ja"]);
for (const language of LANGUAGES) {
  for (const alias of [...language.codes, ...language.names]) {
    TAG_ALIASES.set(alias, language.code);
  }
  for (const name of language.names) {
    TITLE_NAMES.set(name, language.code);
  }
  for (const code of language.codes) {
    if (code.length === 3 || SAFE_TWO_LETTER_TITLE_CODES.has(code)) {
      TITLE_CODES.set(code.toUpperCase(), language.code);
    }
  }
}

const UNKNOWN_TAGS = new Set(["", "und", "mis", "mul", "zxx", "unknown", "undefined", "none"]);

/** Normalizes a container language tag to ISO 639-2/B; undefined when empty/und/unusable. */
export function normalizeLanguageTag(tag: string | undefined): string | undefined {
  const value = tag?.trim().toLowerCase() ?? "";
  if (UNKNOWN_TAGS.has(value)) {
    return undefined;
  }
  const known =
    TAG_ALIASES.get(value) ?? TAG_ALIASES.get(value.split(LOCALE_SEPARATOR_RE)[0] ?? "");
  if (known) {
    return known;
  }
  return ISO_639_2_RE.test(value) ? value : undefined;
}

/** Infers a language from stream-title words ("German", "Deutsch DD5.1", "GER", "English SDH"). */
export function inferLanguageFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  for (const token of title.split(TITLE_TOKEN_RE)) {
    if (token === "") {
      continue;
    }
    const byName = TITLE_NAMES.get(token.toLowerCase());
    if (byName) {
      return byName;
    }
    if (token === token.toUpperCase()) {
      const byCode = TITLE_CODES.get(token);
      if (byCode) {
        return byCode;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ffprobe mapping

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecords(value: unknown): JsonRecord[] {
  return asArray(value).flatMap((entry) => {
    const record = asRecord(entry);
    return record ? [record] : [];
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function tagValue(tags: unknown, key: string): string | undefined {
  const record = asRecord(tags);
  if (!record) {
    return undefined;
  }
  for (const [name, value] of Object.entries(record)) {
    if (name.toLowerCase() === key) {
      return asString(value);
    }
  }
  return undefined;
}

function flag(disposition: unknown, key: string): boolean {
  return asRecord(disposition)?.[key] === 1;
}

function detectHdr(stream: JsonRecord): string | undefined {
  const sideData = asArray(stream.side_data_list).map((entry) =>
    (asString(asRecord(entry)?.side_data_type) ?? "").toLowerCase(),
  );
  if (sideData.some((type) => type.includes("dovi") || type.includes("dolby vision"))) {
    return "DV";
  }
  const transfer = asString(stream.color_transfer)?.toLowerCase();
  if (transfer === "smpte2084") {
    return "HDR10";
  }
  if (transfer === "arib-std-b67") {
    return "HLG";
  }
  return undefined;
}

function baseStream(stream: JsonRecord) {
  const language = tagValue(stream.tags, "language");
  const title = tagValue(stream.tags, "title");
  const inferredLanguage = normalizeLanguageTag(language) ?? inferLanguageFromTitle(title);
  return {
    index: asNumber(stream.index) ?? -1,
    codec: asString(stream.codec_name),
    language,
    title,
    inferredLanguage,
    isDefault: flag(stream.disposition, "default"),
    isForced: flag(stream.disposition, "forced"),
  };
}

type ProbedFile = Omit<MediaProbeOk, "ok" | "path" | "sizeBytes">;

/** Maps raw `ffprobe -of json` output onto the probe result fields. */
export function mapFfprobeOutput(output: unknown): ProbedFile {
  const root = asRecord(output) ?? {};
  const format = asRecord(root.format) ?? {};
  const streams = asRecords(root.streams);

  const videoStream = streams.find(
    (stream) => stream.codec_type === "video" && !flag(stream.disposition, "attached_pic"),
  );
  const audio: ProbeAudioStream[] = streams
    .filter((stream) => stream.codec_type === "audio")
    .map((stream) => ({ ...baseStream(stream), channels: asNumber(stream.channels) }));
  const subtitles: ProbeSubtitleStream[] = streams
    .filter((stream) => stream.codec_type === "subtitle")
    .map((stream) => {
      const base = baseStream(stream);
      return { ...base, textBased: TEXT_SUBTITLE_CODECS.has(base.codec?.toLowerCase() ?? "") };
    });
  const chapters = asRecords(root.chapters);
  const audioLanguages = [...new Set(audio.map((stream) => stream.inferredLanguage ?? "und"))];

  return {
    durationSeconds: asNumber(format.duration),
    containerTitle: tagValue(format.tags, "title"),
    video: videoStream
      ? {
          codec: asString(videoStream.codec_name),
          width: asNumber(videoStream.width),
          height: asNumber(videoStream.height),
          hdr: detectHdr(videoStream),
        }
      : undefined,
    audio,
    subtitles,
    chapters: {
      count: chapters.length,
      titles: chapters
        .flatMap((chapter) => tagValue(chapter.tags, "title") ?? [])
        .slice(0, CHAPTER_TITLE_LIMIT),
    },
    hasGermanAudio: audio.some((stream) => stream.inferredLanguage === "ger"),
    audioLanguages,
  };
}

// ---------------------------------------------------------------------------
// Subtitles

/** Extracts dialogue lines from SRT text: no counters/timestamps/markup, consecutive duplicates collapsed. */
export function parseSrtText(text: string, maxLines = SUBTITLE_EXCERPT_LINES): string[] {
  const lines: string[] = [];
  for (const raw of text.split(LINE_BREAK_RE)) {
    const trimmed = raw.trim();
    if (trimmed === "" || SRT_COUNTER_RE.test(trimmed) || SRT_TIMESTAMP_RE.test(trimmed)) {
      continue;
    }
    const line = trimmed
      .replace(SRT_HTML_TAG_RE, "")
      .replace(SRT_ASS_TAG_RE, "")
      .replace(SRT_ASS_ESCAPE_RE, " ")
      .replace(WHITESPACE_RE, " ")
      .trim()
      .slice(0, SUBTITLE_LINE_MAX_CHARS);
    if (line === "" || line === lines.at(-1)) {
      continue;
    }
    lines.push(line);
    if (lines.length >= maxLines) {
      break;
    }
  }
  return lines;
}

function languageRank(stream: ProbeSubtitleStream): number {
  if (stream.inferredLanguage === "eng") {
    return 0;
  }
  return stream.inferredLanguage === "ger" ? 1 : 2;
}

function pickExcerptStream(subtitles: ProbeSubtitleStream[]): ProbeSubtitleStream | undefined {
  // Forced streams only carry sign/foreign-dialogue lines, so prefer full ones.
  return subtitles
    .filter((stream) => stream.textBased && stream.index >= 0)
    .map((stream, order) => ({ stream, order }))
    .sort(
      (a, b) =>
        languageRank(a.stream) - languageRank(b.stream) ||
        Number(a.stream.isForced) - Number(b.stream.isForced) ||
        a.order - b.order,
    )[0]?.stream;
}

// ---------------------------------------------------------------------------
// NFO

function collect(text: string, patterns: RegExp[]): string[] {
  const ids = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const id = match[1] ?? match[0];
      ids.add(id);
    }
  }
  return [...ids];
}

/** Extracts IMDb/TMDB/TVDB ids and a whitespace-collapsed excerpt from NFO text. */
export function parseNfo(name: string, text: string): ProbeNfo {
  return {
    name,
    imdbIds: collect(text, [IMDB_ID_RE]),
    tmdbIds: collect(text, [TMDB_URL_RE, TMDB_TAG_RE]),
    tvdbIds: collect(text, [TVDB_SERIES_URL_RE, TVDB_QUERY_URL_RE, TVDB_LABEL_RE, TVDB_TAG_RE]),
    excerpt: text.replace(WHITESPACE_RE, " ").trim().slice(0, NFO_EXCERPT_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Errors

function errorField(error: unknown, key: string): unknown {
  return asRecord(error)?.[key];
}

function firstLine(value: string): string {
  const line = value.split("\n").find((entry) => entry.trim() !== "") ?? "";
  return line.trim().slice(0, REASON_MAX_CHARS);
}

function fsReason(error: unknown): string {
  const code = errorField(error, "code");
  if (code === "ENOENT" || code === "ENOTDIR") {
    return "File not found.";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "Permission denied.";
  }
  if (code === "ELOOP") {
    return "Too many symlink levels.";
  }
  return firstLine(error instanceof Error ? error.message : String(error)) || "Filesystem error.";
}

function execReason(tool: string, error: unknown, timeoutMs: number): string {
  const code = errorField(error, "code");
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `${tool} output exceeded the size limit.`;
  }
  if (errorField(error, "killed") === true || code === "ETIMEDOUT") {
    return `${tool} timed out after ${Math.round(timeoutMs / 1000)}s.`;
  }
  if (code === "ENOENT") {
    return `${tool} is not installed.`;
  }
  const stderr = errorField(error, "stderr");
  const detail =
    (typeof stderr === "string" ? firstLine(stderr) : "") ||
    firstLine(error instanceof Error ? error.message : String(error));
  return detail ? `${tool} failed: ${detail}` : `${tool} failed.`;
}

class ProbeError extends Error {}

function compareByName(a: FsDirent, b: FsDirent): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

function failureReason(error: unknown): string {
  if (error instanceof ProbeError) return error.message;
  return firstLine(error instanceof Error ? error.message : String(error)) || "Probe failed.";
}

// ---------------------------------------------------------------------------
// Defaults

const defaultExec: ExecFn = (file, args, { timeoutMs, maxBuffer }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

const defaultFs: FsPort = {
  realpath: (target) => realpath(target),
  stat: (target) => stat(target),
  readdir: (target) => readdir(target, { withFileTypes: true }),
  async readFileHead(target, maxBytes) {
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  },
};

// ---------------------------------------------------------------------------
// Prober

export function createMediaProber(options: MediaProberOptions): MediaProber {
  const pathMap = [...options.pathMap];
  const exec = options.exec ?? defaultExec;
  const fs = options.fs ?? defaultFs;
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const probeTimeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const subtitleTimeoutMs = options.subtitleTimeoutMs ?? DEFAULT_SUBTITLE_TIMEOUT_MS;

  async function resolveLocal(arrPath: string): Promise<{ file: string; root: string }> {
    const mapped = mapArrPath(arrPath, pathMap);
    if (!mapped.ok) {
      throw new ProbeError(mapped.reason);
    }
    let root: string;
    let file: string;
    try {
      root = await fs.realpath(mapped.root);
      file = await fs.realpath(mapped.localPath);
    } catch (error) {
      throw new ProbeError(fsReason(error));
    }
    if (!isInside(file, root)) {
      throw new ProbeError("Path escapes the mapped media root.");
    }
    return { file, root };
  }

  async function runFfprobe(file: string): Promise<ProbedFile> {
    let stdout: string;
    try {
      ({ stdout } = await exec(
        ffprobePath,
        ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file],
        { timeoutMs: probeTimeoutMs, maxBuffer: MAX_BUFFER_BYTES },
      ));
    } catch (error) {
      throw new ProbeError(execReason("ffprobe", error, probeTimeoutMs));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new ProbeError("ffprobe returned invalid JSON.");
    }
    return mapFfprobeOutput(parsed);
  }

  async function subtitleExcerpt(
    file: string,
    subtitles: ProbeSubtitleStream[],
  ): Promise<MediaProbeOk["subtitleExcerpt"]> {
    const stream = pickExcerptStream(subtitles);
    if (!stream) {
      return undefined;
    }
    try {
      const { stdout } = await exec(
        ffmpegPath,
        [
          "-v",
          "error",
          "-nostdin",
          "-ss",
          "0",
          "-i",
          file,
          "-map",
          `0:${stream.index}`,
          "-t",
          String(SUBTITLE_EXCERPT_SECONDS),
          "-f",
          "srt",
          "pipe:1",
        ],
        { timeoutMs: subtitleTimeoutMs, maxBuffer: MAX_BUFFER_BYTES },
      );
      const lines = parseSrtText(stdout);
      return lines.length > 0
        ? { streamIndex: stream.index, language: stream.inferredLanguage, lines }
        : undefined;
    } catch {
      // An excerpt is a bonus; the probe itself still succeeded.
      return undefined;
    }
  }

  async function readNfos(directory: string, root: string, names: string[]): Promise<ProbeNfo[]> {
    const nfos: ProbeNfo[] = [];
    for (const name of names.slice(0, NFO_MAX_FILES)) {
      try {
        const real = await fs.realpath(path.posix.join(directory, name));
        if (!isInside(real, root)) {
          continue;
        }
        nfos.push(parseNfo(name, await fs.readFileHead(real, NFO_MAX_BYTES)));
      } catch {
        // Unreadable NFOs are skipped; they are hints, not requirements.
      }
    }
    return nfos;
  }

  async function folderListing(
    file: string,
    root: string,
  ): Promise<Pick<MediaProbeOk, "folder" | "nfos">> {
    const directory = path.posix.dirname(file);
    let dirents: FsDirent[];
    try {
      dirents = await fs.readdir(directory);
    } catch {
      return {};
    }
    const sorted = [...dirents].sort(compareByName);
    const entries: ProbeFolderEntry[] = await Promise.all(
      sorted.slice(0, FOLDER_MAX_ENTRIES).map(async (dirent) => {
        const isDirectory = dirent.isDirectory();
        let sizeBytes = 0;
        if (!isDirectory) {
          try {
            sizeBytes = (await fs.stat(path.posix.join(directory, dirent.name))).size;
          } catch {
            sizeBytes = 0;
          }
        }
        return { name: dirent.name, sizeBytes, isDirectory };
      }),
    );
    const nfoNames = sorted
      .filter((dirent) => dirent.isFile() && dirent.name.toLowerCase().endsWith(".nfo"))
      .map((dirent) => dirent.name);
    return {
      folder: { entries, truncated: sorted.length > FOLDER_MAX_ENTRIES },
      nfos: await readNfos(directory, root, nfoNames),
    };
  }

  /** Size of a regular file; throws ProbeError for anything else. */
  async function regularFileSize(file: string): Promise<number> {
    let info: Awaited<ReturnType<FsPort["stat"]>>;
    try {
      info = await fs.stat(file);
    } catch (error) {
      throw new ProbeError(fsReason(error));
    }
    if (!info.isFile()) throw new ProbeError("Not a regular file.");
    return info.size;
  }

  async function probeFile(
    arrPath: string,
    probeOptions: MediaProbeOptions,
  ): Promise<MediaProbeOk> {
    const { file, root } = await resolveLocal(arrPath);
    const sizeBytes = await regularFileSize(file);
    const probed = await runFfprobe(file);
    const [excerpt, folder] = await Promise.all([
      probeOptions.subtitleExcerpt ? subtitleExcerpt(file, probed.subtitles) : undefined,
      probeOptions.folder ? folderListing(file, root) : undefined,
    ]);
    return {
      ok: true,
      path: arrPath,
      sizeBytes,
      ...probed,
      ...(excerpt ? { subtitleExcerpt: excerpt } : {}),
      ...(folder?.folder ? { folder: folder.folder, nfos: folder.nfos } : {}),
    };
  }

  async function probe(
    arrPath: string,
    probeOptions: MediaProbeOptions = {},
  ): Promise<MediaProbeResult> {
    if (pathMap.length === 0) {
      return { ok: false, path: arrPath, reason: NOT_CONFIGURED_REASON };
    }
    try {
      return await probeFile(arrPath, probeOptions);
    } catch (error) {
      return { ok: false, path: arrPath, reason: failureReason(error) } satisfies MediaProbeFailure;
    }
  }

  return { available: pathMap.length > 0, probe };
}
