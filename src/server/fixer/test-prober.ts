import type { MediaProbeOk, MediaProbeResult, MediaProber } from "../media/types.js";

/**
 * Test double for the media prober. By default every path inspects as a
 * readable file with no streams, so guards that need real-file facts stay
 * neutral; pass per-path overrides to describe specific files.
 */
export function fakeProber(
  files: Record<string, Partial<MediaProbeOk> | { ok: false; reason: string }> = {},
): MediaProber & { calls: string[] } {
  const calls: string[] = [];
  return {
    available: true,
    calls,
    async probe(path): Promise<MediaProbeResult> {
      calls.push(path);
      const override = files[path];
      if (override && "ok" in override && override.ok === false) {
        return { ok: false, path, reason: override.reason };
      }
      return {
        ok: true,
        path,
        sizeBytes: 1,
        audio: [],
        subtitles: [],
        chapters: { count: 0, titles: [] },
        hasGermanAudio: false,
        audioLanguages: [],
        ...(override as Partial<MediaProbeOk> | undefined),
      };
    },
  };
}

/** A German audio stream as the prober reports it. */
export function germanAudio(title?: string) {
  return { index: 1, codec: "ac3", language: "ger", inferredLanguage: "ger", title, channels: 6 };
}

/** An English audio stream as the prober reports it. */
export function englishAudio() {
  return { index: 2, codec: "eac3", language: "eng", inferredLanguage: "eng", channels: 6 };
}
