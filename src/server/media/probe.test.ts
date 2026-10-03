import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMediaProber,
  type ExecFn,
  type FsDirent,
  type FsPort,
  inferLanguageFromTitle,
  mapFfprobeOutput,
  normalizeLanguageTag,
  parseMediaPathMap,
  parseNfo,
  parseSrtText,
} from "./probe.js";
import type { MediaProbeOk, MediaProbeResult } from "./types.js";

// ---------------------------------------------------------------------------
// Fakes: an in-memory filesystem and a scripted exec. Nothing real is touched.

type FakeNode = { kind: "file"; size: number; content?: string } | { kind: "dir" };

function fakeFs(
  nodes: Record<string, FakeNode>,
  symlinks: Record<string, string> = {},
): FsPort & { reads: string[] } {
  const reads: string[] = [];
  const enoent = (target: string) =>
    Object.assign(new Error(`ENOENT: no such file or directory, '${target}'`), { code: "ENOENT" });
  const resolve = (target: string): string => {
    const direct = symlinks[target];
    if (direct) {
      return direct;
    }
    for (const [link, dest] of Object.entries(symlinks)) {
      if (target.startsWith(`${link}/`)) {
        return dest + target.slice(link.length);
      }
    }
    return target;
  };
  const lookup = (target: string): FakeNode => {
    const node = nodes[resolve(target)];
    if (!node) {
      throw enoent(target);
    }
    return node;
  };
  return {
    reads,
    async realpath(target) {
      lookup(target);
      return resolve(target);
    },
    async stat(target) {
      const node = lookup(target);
      return {
        size: node.kind === "file" ? node.size : 4096,
        isFile: () => node.kind === "file",
        isDirectory: () => node.kind === "dir",
      };
    },
    async readdir(target) {
      const dir = resolve(target);
      if (nodes[dir]?.kind !== "dir") {
        throw enoent(target);
      }
      const entries: FsDirent[] = [];
      for (const [nodePath, node] of Object.entries(nodes)) {
        if (path.posix.dirname(nodePath) === dir && nodePath !== dir) {
          entries.push({
            name: path.posix.basename(nodePath),
            isFile: () => node.kind === "file",
            isDirectory: () => node.kind === "dir",
          });
        }
      }
      return entries.reverse(); // unsorted on purpose
    },
    async readFileHead(target, maxBytes) {
      const node = lookup(target);
      reads.push(target);
      return node.kind === "file" ? (node.content ?? "").slice(0, maxBytes) : "";
    },
  };
}

type ExecCall = { file: string; args: readonly string[]; timeoutMs: number };

function scriptedExec(handlers: {
  ffprobe?: (args: readonly string[]) => string | Error;
  ffmpeg?: (args: readonly string[]) => string | Error;
}): ExecFn & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = vi.fn<ExecFn>(async (file, args, options) => {
    calls.push({ file, args, timeoutMs: options.timeoutMs });
    const handler = file.includes("ffprobe") ? handlers.ffprobe : handlers.ffmpeg;
    const out = handler ? handler(args) : new Error(`unexpected exec ${file}`);
    if (out instanceof Error) {
      throw out;
    }
    return { stdout: out, stderr: "" };
  });
  return Object.assign(exec, { calls });
}

// ---------------------------------------------------------------------------
// Realistic ffprobe fixtures

const germanRemux = {
  streams: [
    {
      index: 0,
      codec_name: "hevc",
      codec_type: "video",
      width: 3840,
      height: 2160,
      color_transfer: "smpte2084",
      side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 7 }],
      disposition: { default: 1, attached_pic: 0 },
    },
    {
      index: 1,
      codec_name: "dts",
      codec_type: "audio",
      profile: "DTS-HD MA",
      channels: 8,
      disposition: { default: 1, forced: 0 },
      tags: { language: "", title: "German" },
    },
    {
      index: 2,
      codec_name: "truehd",
      codec_type: "audio",
      channels: 8,
      disposition: { default: 0, forced: 0 },
      tags: { language: "eng", title: "English Atmos" },
    },
    {
      index: 3,
      codec_name: "ac3",
      codec_type: "audio",
      channels: 2,
      disposition: { default: 0, forced: 0 },
      tags: { language: "und", title: "Commentary" },
    },
    {
      index: 4,
      codec_name: "hdmv_pgs_subtitle",
      codec_type: "subtitle",
      disposition: { default: 0, forced: 1 },
      tags: { language: "ger", title: "Forced" },
    },
    {
      index: 5,
      codec_name: "subrip",
      codec_type: "subtitle",
      disposition: { default: 0, forced: 0 },
      tags: { language: "ger", title: "Deutsch" },
    },
    {
      index: 6,
      codec_name: "subrip",
      codec_type: "subtitle",
      disposition: { default: 0, forced: 0 },
      tags: { LANGUAGE: "eng", TITLE: "English SDH" },
    },
    {
      index: 7,
      codec_name: "mjpeg",
      codec_type: "video",
      width: 600,
      height: 900,
      disposition: { default: 0, attached_pic: 1 },
      tags: { filename: "cover.jpg", mimetype: "image/jpeg" },
    },
  ],
  chapters: Array.from({ length: 24 }, (_, i) => ({
    id: i,
    start_time: String(i * 300),
    tags: { title: `Chapter ${i + 1}` },
  })),
  format: {
    filename: "/arr-data/media/Filme/Heat (1995)/Heat (1995).mkv",
    format_name: "matroska,webm",
    duration: "10224.512000",
    size: "64424509440",
    tags: { TITLE: "Heat", ENCODER: "libebml v1.4.2" },
  },
};

const coverFirstMp4 = {
  streams: [
    {
      index: 0,
      codec_name: "png",
      codec_type: "video",
      width: 500,
      height: 500,
      disposition: { attached_pic: 1 },
    },
    {
      index: 1,
      codec_name: "h264",
      codec_type: "video",
      width: 1920,
      height: 1080,
      color_transfer: "arib-std-b67",
      disposition: { default: 1, attached_pic: 0 },
    },
    {
      index: 2,
      codec_name: "aac",
      codec_type: "audio",
      channels: 2,
      disposition: { default: 1 },
      tags: { language: "und", handler_name: "SoundHandler" },
    },
  ],
  format: { duration: "1420.1" },
};

// ---------------------------------------------------------------------------

const MOVIE_ARR = "/data/media/Filme/Heat (1995)/Heat (1995).mkv";
const MOVIE_LOCAL = "/arr-data/media/Filme/Heat (1995)/Heat (1995).mkv";

function movieFs(extra: Record<string, FakeNode> = {}, symlinks: Record<string, string> = {}) {
  return fakeFs(
    {
      "/arr-data": { kind: "dir" },
      "/arr-data/media": { kind: "dir" },
      "/arr-data/media/Filme": { kind: "dir" },
      "/arr-data/media/Filme/Heat (1995)": { kind: "dir" },
      [MOVIE_LOCAL]: { kind: "file", size: 64_424_509_440 },
      ...extra,
    },
    symlinks,
  );
}

function expectOk(result: MediaProbeResult): MediaProbeOk {
  if (!result.ok) {
    throw new Error(`expected ok, got: ${result.reason}`);
  }
  return result;
}

function expectFailure(result: MediaProbeResult, reason: string | RegExp) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    if (typeof reason === "string") {
      expect(result.reason).toBe(reason);
    } else {
      expect(result.reason).toMatch(reason);
    }
  }
}

const probeJson = (fixture: unknown) => () => JSON.stringify(fixture);

describe("parseMediaPathMap", () => {
  it("parses comma-separated FROM=TO pairs and ignores blanks", () => {
    expect(parseMediaPathMap(" /data=/arr-data , ,/downloads/=/dl/ ")).toEqual([
      { from: "/data", to: "/arr-data" },
      { from: "/downloads", to: "/dl" },
    ]);
  });

  it("returns an empty map when unset or blank", () => {
    expect(parseMediaPathMap(undefined)).toEqual([]);
    expect(parseMediaPathMap("")).toEqual([]);
    expect(parseMediaPathMap(" , ")).toEqual([]);
  });

  it.each(["data=/arr-data", "/data=arr-data", "/data", "=/arr-data", "/data="])(
    "rejects invalid entry %s",
    (value) => {
      expect(() => parseMediaPathMap(value)).toThrow("Invalid FIXER_MEDIA_PATH_MAP entry");
    },
  );
});

describe("createMediaProber availability", () => {
  it("is unavailable and refuses to probe without a path map", async () => {
    const exec = scriptedExec({});
    const prober = createMediaProber({ pathMap: [], exec, fs: movieFs() });
    expect(prober.available).toBe(false);
    expect(await prober.probe(MOVIE_ARR)).toEqual({
      ok: false,
      path: MOVIE_ARR,
      reason: "Media probing is not configured (FIXER_MEDIA_PATH_MAP).",
    });
    expect(exec.calls).toHaveLength(0);
  });

  it("is available with a mapping", () => {
    expect(createMediaProber({ pathMap: parseMediaPathMap("/data=/arr-data") }).available).toBe(
      true,
    );
  });
});

describe("path safety", () => {
  const pathMap = parseMediaPathMap("/data=/arr-data");

  it("maps the arr path onto the local mount and passes it to ffprobe without a shell", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const prober = createMediaProber({ pathMap, exec, fs: movieFs() });
    expectOk(await prober.probe(MOVIE_ARR));
    expect(exec.calls[0]).toEqual({
      file: "ffprobe",
      args: [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        "-of",
        "json",
        MOVIE_LOCAL,
      ],
      timeoutMs: 30_000,
    });
  });

  it("matches prefixes on segment boundaries only", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const fs = movieFs({ "/arr-database/x.mkv": { kind: "file", size: 1 } });
    const prober = createMediaProber({ pathMap, exec, fs });
    expectFailure(
      await prober.probe("/database/x.mkv"),
      "Path is outside every configured media mapping.",
    );
    expect(exec.calls).toHaveLength(0);
  });

  it("uses the longest matching prefix among multiple mappings", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(coverFirstMp4) });
    const fs = fakeFs({
      "/arr-data": { kind: "dir" },
      "/nzb": { kind: "dir" },
      "/nzb/movies/X/X.mkv": { kind: "file", size: 10 },
    });
    const prober = createMediaProber({
      pathMap: parseMediaPathMap("/data=/arr-data,/data/usenet/complete=/nzb"),
      exec,
      fs,
    });
    const result = expectOk(await prober.probe("/data/usenet/complete/movies/X/X.mkv"));
    expect(result.path).toBe("/data/usenet/complete/movies/X/X.mkv");
    expect(exec.calls[0]?.args.at(-1)).toBe("/nzb/movies/X/X.mkv");
  });

  it.each([
    ["/data/../etc/passwd", "Path must not contain '..' segments."],
    ["/data/media/../../etc/passwd", "Path must not contain '..' segments."],
    ["data/media/x.mkv", "Path must be absolute."],
    ["", "Path is empty."],
    ["/data/media/x\0.mkv", "Path contains a NUL byte."],
    ["/srv/media/x.mkv", "Path is outside every configured media mapping."],
  ])("rejects %j", async (arrPath, reason) => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const prober = createMediaProber({ pathMap, exec, fs: movieFs() });
    expectFailure(await prober.probe(arrPath), reason);
    expect(exec.calls).toHaveLength(0);
  });

  it("rejects a symlink that escapes the mapped root", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const fs = movieFs(
      { "/etc/shadow": { kind: "file", size: 1 } },
      { "/arr-data/media/evil.mkv": "/etc/shadow" },
    );
    const prober = createMediaProber({ pathMap, exec, fs });
    expectFailure(
      await prober.probe("/data/media/evil.mkv"),
      "Path escapes the mapped media root.",
    );
    expect(exec.calls).toHaveLength(0);
  });

  it("allows a symlink that stays inside the mapped root", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const fs = movieFs({}, { "/arr-data/link.mkv": MOVIE_LOCAL });
    const prober = createMediaProber({ pathMap, exec, fs });
    expect(expectOk(await prober.probe("/data/link.mkv")).sizeBytes).toBe(64_424_509_440);
    expect(exec.calls[0]?.args.at(-1)).toBe(MOVIE_LOCAL);
  });

  it("compares against the real path of the mount root", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const fs = fakeFs(
      { "/mnt/nfs": { kind: "dir" }, "/mnt/nfs/a.mkv": { kind: "file", size: 5 } },
      { "/arr-data": "/mnt/nfs" },
    );
    const prober = createMediaProber({ pathMap, exec, fs });
    expect(expectOk(await prober.probe("/data/a.mkv")).sizeBytes).toBe(5);
  });

  it("reports missing files and non-files", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const prober = createMediaProber({ pathMap, exec, fs: movieFs() });
    expectFailure(await prober.probe("/data/media/missing.mkv"), "File not found.");
    expectFailure(await prober.probe("/data/media/Filme"), "Not a regular file.");
    expect(exec.calls).toHaveLength(0);
  });
});

describe("ffprobe mapping", () => {
  it("maps a German DV remux with an untagged German track, cover art and chapters", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const prober = createMediaProber({
      pathMap: parseMediaPathMap("/data=/arr-data"),
      exec,
      fs: movieFs(),
    });
    const result = expectOk(await prober.probe(MOVIE_ARR));
    expect(result).toMatchObject({
      ok: true,
      path: MOVIE_ARR,
      sizeBytes: 64_424_509_440,
      durationSeconds: 10224.512,
      containerTitle: "Heat",
      video: { codec: "hevc", width: 3840, height: 2160, hdr: "DV" },
      hasGermanAudio: true,
      audioLanguages: ["ger", "eng", "und"],
    });
    expect(result.audio).toEqual([
      {
        index: 1,
        codec: "dts",
        language: undefined,
        title: "German",
        inferredLanguage: "ger",
        isDefault: true,
        isForced: false,
        channels: 8,
      },
      {
        index: 2,
        codec: "truehd",
        language: "eng",
        title: "English Atmos",
        inferredLanguage: "eng",
        isDefault: false,
        isForced: false,
        channels: 8,
      },
      {
        index: 3,
        codec: "ac3",
        language: "und",
        title: "Commentary",
        inferredLanguage: undefined,
        isDefault: false,
        isForced: false,
        channels: 2,
      },
    ]);
    expect(
      result.subtitles.map((s) => [s.index, s.inferredLanguage, s.textBased, s.isForced]),
    ).toEqual([
      [4, "ger", false, true],
      [5, "ger", true, false],
      [6, "eng", true, false],
    ]);
    expect(result.subtitles[2]?.title).toBe("English SDH");
    expect(result.chapters.count).toBe(24);
    expect(result.chapters.titles).toHaveLength(20);
    expect(result.chapters.titles[0]).toBe("Chapter 1");
    expect(result.subtitleExcerpt).toBeUndefined();
    expect(result.folder).toBeUndefined();
    expect(result.nfos).toBeUndefined();
  });

  it("skips a leading cover image, detects HLG, and reports unknown audio as und", () => {
    const mapped = mapFfprobeOutput(coverFirstMp4);
    expect(mapped.video).toEqual({ codec: "h264", width: 1920, height: 1080, hdr: "HLG" });
    expect(mapped.hasGermanAudio).toBe(false);
    expect(mapped.audioLanguages).toEqual(["und"]);
    expect(mapped.chapters).toEqual({ count: 0, titles: [] });
    expect(mapped.containerTitle).toBeUndefined();
    expect(mapped.durationSeconds).toBe(1420.1);
  });

  it("detects HDR10 and tolerates missing sections", () => {
    expect(
      mapFfprobeOutput({
        streams: [
          { index: 0, codec_type: "video", codec_name: "hevc", color_transfer: "smpte2084" },
        ],
      }).video?.hdr,
    ).toBe("HDR10");
    expect(mapFfprobeOutput({})).toMatchObject({
      video: undefined,
      audio: [],
      subtitles: [],
      hasGermanAudio: false,
      audioLanguages: [],
    });
    expect(mapFfprobeOutput(null).audio).toEqual([]);
  });

  it("returns ok:false on invalid JSON", async () => {
    const prober = createMediaProber({
      pathMap: parseMediaPathMap("/data=/arr-data"),
      exec: scriptedExec({ ffprobe: () => "not json" }),
      fs: movieFs(),
    });
    expectFailure(await prober.probe(MOVIE_ARR), "ffprobe returned invalid JSON.");
  });

  it("reports a killed (timed out) ffprobe with the configured timeout", async () => {
    const exec = scriptedExec({
      ffprobe: () =>
        Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" }),
    });
    const prober = createMediaProber({
      pathMap: parseMediaPathMap("/data=/arr-data"),
      exec,
      fs: movieFs(),
      timeoutMs: 5000,
    });
    expectFailure(await prober.probe(MOVIE_ARR), "ffprobe timed out after 5s.");
    expect(exec.calls[0]?.timeoutMs).toBe(5000);
  });

  it.each([
    [{ code: "ENOENT" }, "ffprobe is not installed."],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "ffprobe output exceeded the size limit."],
    [
      { code: 1, stderr: "/arr-data/x.mkv: Invalid data found when processing input\n" },
      "ffprobe failed: /arr-data/x.mkv: Invalid data found when processing input",
    ],
  ])("maps exec failure %j to a short reason", async (fields, reason) => {
    const prober = createMediaProber({
      pathMap: parseMediaPathMap("/data=/arr-data"),
      exec: scriptedExec({ ffprobe: () => Object.assign(new Error("boom\n    at stack"), fields) }),
      fs: movieFs(),
    });
    expectFailure(await prober.probe(MOVIE_ARR), reason);
  });

  it("uses custom binary paths", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux), ffmpeg: () => "1\nHi\n" });
    const prober = createMediaProber({
      pathMap: parseMediaPathMap("/data=/arr-data"),
      exec,
      fs: movieFs(),
      ffprobePath: "/usr/local/bin/ffprobe",
      ffmpegPath: "/usr/local/bin/ffmpeg",
    });
    expectOk(await prober.probe(MOVIE_ARR, { subtitleExcerpt: true }));
    expect(exec.calls.map((call) => call.file)).toEqual([
      "/usr/local/bin/ffprobe",
      "/usr/local/bin/ffmpeg",
    ]);
  });
});

describe("language normalization", () => {
  it.each([
    ["ger", "ger"],
    ["deu", "ger"],
    ["de", "ger"],
    ["German", "ger"],
    ["de-DE", "ger"],
    ["eng", "eng"],
    ["en", "eng"],
    ["English", "eng"],
    ["ja", "jpn"],
    ["fra", "fre"],
    ["es", "spa"],
    ["it", "ita"],
    ["zho", "chi"],
    ["pol", "pol"],
    ["xyz", "xyz"],
    ["und", undefined],
    ["", undefined],
    [undefined, undefined],
    ["12", undefined],
  ])("normalizes tag %j to %j", (input, expected) => {
    expect(normalizeLanguageTag(input)).toBe(expected);
  });

  it.each([
    ["German", "ger"],
    ["Deutsch DD5.1", "ger"],
    ["GER DTS-HD MA", "ger"],
    ["DE AC3", "ger"],
    ["English SDH", "eng"],
    ["Englisch (Kommentar)", "eng"],
    ["ENG", "eng"],
    ["Japanese", "jpn"],
    ["Japanisch 2.0", "jpn"],
    ["Französisch", "fre"],
    ["Italienisch", "ita"],
    ["Spanish (Latin America)", "spa"],
    ["Commentary", undefined],
    ["Surround 5.1", undefined],
    ["ger", undefined],
    ["English HI", "eng"],
    [undefined, undefined],
  ])("infers %j from title as %j", (title, expected) => {
    expect(inferLanguageFromTitle(title)).toBe(expected);
  });

  it("prefers the tag over the title", () => {
    const mapped = mapFfprobeOutput({
      streams: [
        { index: 1, codec_type: "audio", tags: { language: "eng", title: "German dub" } },
        { index: 2, codec_type: "audio", tags: { language: "und", title: "Deutsch" } },
        { index: 3, codec_type: "audio", tags: { language: "ger" } },
      ],
    });
    expect(mapped.audio.map((a) => a.inferredLanguage)).toEqual(["eng", "ger", "ger"]);
    expect(mapped.audioLanguages).toEqual(["eng", "ger"]);
  });
});

describe("parseSrtText", () => {
  it("drops counters, timestamps, blanks and markup and collapses repeats", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:03,000",
      "<i>Where's the money,</i>",
      "{\\an8}Neil?",
      "",
      "2",
      "00:00:04,000 --> 00:00:05,000",
      "Neil?",
      "",
      "3",
      "00:00:06,000 --> 00:00:07,000",
      '<font color="#ffff00">  It\'s   gone. </font>',
      "Line\\Nbreak",
      "",
    ].join("\r\n");
    expect(parseSrtText(srt)).toEqual(["Where's the money,", "Neil?", "It's gone.", "Line break"]);
  });

  it("caps line count and line length", () => {
    const srt = Array.from(
      { length: 60 },
      (_, i) =>
        `${i + 1}\n00:00:0${i % 10},000 --> 00:00:0${i % 10},500\nLine ${i} ${"x".repeat(300)}\n`,
    ).join("\n");
    const lines = parseSrtText(srt);
    expect(lines).toHaveLength(40);
    expect(lines.every((line) => line.length <= 200)).toBe(true);
    expect(lines[0]?.startsWith("Line 0 ")).toBe(true);
  });
});

describe("subtitle excerpt", () => {
  const pathMap = parseMediaPathMap("/data=/arr-data");
  const srt =
    "1\n00:00:01,000 --> 00:00:02,000\n<i>Hello.</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye.\n";

  it("extracts from the English text stream via ffmpeg", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux), ffmpeg: () => srt });
    const prober = createMediaProber({ pathMap, exec, fs: movieFs() });
    const result = expectOk(await prober.probe(MOVIE_ARR, { subtitleExcerpt: true }));
    expect(result.subtitleExcerpt).toEqual({
      streamIndex: 6,
      language: "eng",
      lines: ["Hello.", "Bye."],
    });
    expect(exec.calls[1]).toEqual({
      file: "ffmpeg",
      args: [
        "-v",
        "error",
        "-nostdin",
        "-ss",
        "0",
        "-i",
        MOVIE_LOCAL,
        "-map",
        "0:6",
        "-t",
        "1200",
        "-f",
        "srt",
        "pipe:1",
      ],
      timeoutMs: 60_000,
    });
  });

  it("falls back to German, skipping image subtitles and forced streams", async () => {
    const fixture = {
      ...germanRemux,
      streams: [
        ...germanRemux.streams.filter((s) => s.index !== 6 && s.index !== 5),
        {
          index: 8,
          codec_name: "ass",
          codec_type: "subtitle",
          disposition: { forced: 1 },
          tags: { language: "ger", title: "Forced" },
        },
        {
          index: 9,
          codec_name: "ass",
          codec_type: "subtitle",
          disposition: { forced: 0 },
          tags: { language: "ger", title: "Full" },
        },
      ],
    };
    const exec = scriptedExec({ ffprobe: probeJson(fixture), ffmpeg: () => srt });
    const prober = createMediaProber({ pathMap, exec, fs: movieFs() });
    const result = expectOk(await prober.probe(MOVIE_ARR, { subtitleExcerpt: true }));
    expect(result.subtitleExcerpt?.streamIndex).toBe(9);
    expect(result.subtitleExcerpt?.language).toBe("ger");
  });

  it("omits the excerpt without failing when there is no text stream", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(coverFirstMp4), ffmpeg: () => srt });
    const prober = createMediaProber({ pathMap, exec, fs: movieFs() });
    const result = expectOk(await prober.probe(MOVIE_ARR, { subtitleExcerpt: true }));
    expect(result.subtitleExcerpt).toBeUndefined();
    expect(exec.calls).toHaveLength(1);
  });

  it("omits the excerpt without failing when ffmpeg times out", async () => {
    const exec = scriptedExec({
      ffprobe: probeJson(germanRemux),
      ffmpeg: () => Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }),
    });
    const prober = createMediaProber({ pathMap, exec, fs: movieFs(), subtitleTimeoutMs: 1000 });
    const result = expectOk(await prober.probe(MOVIE_ARR, { subtitleExcerpt: true }));
    expect(result.subtitleExcerpt).toBeUndefined();
    expect(result.hasGermanAudio).toBe(true);
    expect(exec.calls[1]?.timeoutMs).toBe(1000);
  });

  it("does not run ffmpeg unless asked", async () => {
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux), ffmpeg: () => srt });
    const prober = createMediaProber({ pathMap, exec, fs: movieFs() });
    expectOk(await prober.probe(MOVIE_ARR));
    expect(exec.calls.map((call) => call.file)).toEqual(["ffprobe"]);
  });
});

describe("parseNfo", () => {
  it("extracts ids from URLs, labels and Kodi tags", () => {
    const nfo = `<?xml version="1.0"?>
<movie>
  <title>Heat</title>
  <uniqueid type="imdb" default="true">tt0113277</uniqueid>
  <uniqueid type="tmdb">949</uniqueid>
  <tvdbid>81189</tvdbid>
</movie>
https://www.imdb.com/title/tt0113277/
https://www.themoviedb.org/movie/949-heat
https://www.themoviedb.org/tv/1396
https://thetvdb.com/series/81189
https://thetvdb.com/dereferrer/series/12345
https://thetvdb.com/?tab=series&id=73255
https://thetvdb.com/series/the-office-us/seasons/official/1
tvdb:79168`;
    const parsed = parseNfo("movie.nfo", nfo);
    expect(parsed.name).toBe("movie.nfo");
    expect(parsed.imdbIds).toEqual(["tt0113277"]);
    expect(parsed.tmdbIds).toEqual(["949", "1396"]);
    expect(parsed.tvdbIds.sort()).toEqual(["12345", "73255", "79168", "81189"]);
    expect(parsed.excerpt.startsWith('<?xml version="1.0"?> <movie> <title>Heat</title>')).toBe(
      true,
    );
    expect(parsed.excerpt.length).toBeLessThanOrEqual(400);
  });

  it("returns empty id lists for a scene NFO without ids", () => {
    expect(parseNfo("x.nfo", "  RELEASE  INFO\n\n  Group: FOO  ")).toEqual({
      name: "x.nfo",
      imdbIds: [],
      tmdbIds: [],
      tvdbIds: [],
      excerpt: "RELEASE INFO Group: FOO",
    });
  });
});

describe("folder listing", () => {
  const pathMap = parseMediaPathMap("/data=/arr-data");
  const dir = "/arr-data/media/Filme/Heat (1995)";

  it("lists the containing folder sorted with sizes and reads NFOs", async () => {
    const fs = movieFs({
      [`${dir}/Subs`]: { kind: "dir" },
      [`${dir}/movie.nfo`]: {
        kind: "file",
        size: 120,
        content: '<movie><uniqueid type="imdb">tt0113277</uniqueid></movie>',
      },
      [`${dir}/poster.jpg`]: { kind: "file", size: 2048 },
    });
    const exec = scriptedExec({ ffprobe: probeJson(germanRemux) });
    const prober = createMediaProber({ pathMap, exec, fs });
    const result = expectOk(await prober.probe(MOVIE_ARR, { folder: true }));
    expect(result.folder).toEqual({
      truncated: false,
      entries: [
        { name: "Heat (1995).mkv", sizeBytes: 64_424_509_440, isDirectory: false },
        { name: "Subs", sizeBytes: 0, isDirectory: true },
        { name: "movie.nfo", sizeBytes: 120, isDirectory: false },
        { name: "poster.jpg", sizeBytes: 2048, isDirectory: false },
      ],
    });
    expect(result.nfos).toEqual([
      expect.objectContaining({ name: "movie.nfo", imdbIds: ["tt0113277"] }),
    ]);
  });

  it("truncates at 60 entries and reads at most 3 NFOs", async () => {
    const extra: Record<string, { kind: "file"; size: number; content: string }> = {};
    for (let i = 0; i < 70; i++) {
      const name = i < 5 ? `n${i}.NFO` : `f${String(i).padStart(2, "0")}.txt`;
      extra[`${dir}/${name}`] = { kind: "file", size: i, content: `tt00000${10 + i}` };
    }
    const fs = movieFs(extra);
    const prober = createMediaProber({
      pathMap,
      exec: scriptedExec({ ffprobe: probeJson(germanRemux) }),
      fs,
    });
    const result = expectOk(await prober.probe(MOVIE_ARR, { folder: true }));
    expect(result.folder?.entries).toHaveLength(60);
    expect(result.folder?.truncated).toBe(true);
    expect(result.nfos?.map((nfo) => nfo.name)).toEqual(["n0.NFO", "n1.NFO", "n2.NFO"]);
    expect(fs.reads).toHaveLength(3);
  });

  it("does not read an NFO that symlinks outside the root", async () => {
    const fs = movieFs(
      { "/secret/x.nfo": { kind: "file", size: 1, content: "tt1234567" } },
      { [`${dir}/evil.nfo`]: "/secret/x.nfo" },
    );
    // The fake readdir lists only real nodes, so add the link name explicitly.
    const readdir = fs.readdir.bind(fs);
    fs.readdir = async (target) => [
      ...(await readdir(target)),
      { name: "evil.nfo", isFile: () => true, isDirectory: () => false },
    ];
    const prober = createMediaProber({
      pathMap,
      exec: scriptedExec({ ffprobe: probeJson(germanRemux) }),
      fs,
    });
    const result = expectOk(await prober.probe(MOVIE_ARR, { folder: true }));
    expect(result.nfos).toEqual([]);
    expect(fs.reads).toEqual([]);
  });
});
