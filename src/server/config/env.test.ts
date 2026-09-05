import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv external arr URLs", () => {
  it("accepts http(s) base URLs with an optional path", () => {
    expect(
      loadEnv({
        NODE_ENV: "test",
        SONARR_EXTERNAL_URL: "https://sonarr.example.test/base/",
        RADARR_EXTERNAL_URL: "http://radarr.example.test:7878",
      }),
    ).toMatchObject({
      SONARR_EXTERNAL_URL: "https://sonarr.example.test/base/",
      RADARR_EXTERNAL_URL: "http://radarr.example.test:7878",
    });
  });

  it.each([
    "javascript:alert(1)",
    ["https://user:", "credential@sonarr.example.test"].join(""),
    "https://sonarr.example.test?apiKey=secret",
    "https://sonarr.example.test#fragment",
  ])("rejects unsafe external URL %s", (SONARR_EXTERNAL_URL) => {
    expect(() => loadEnv({ NODE_ENV: "test", SONARR_EXTERNAL_URL })).toThrow("Invalid environment");
  });
});

it("starts from the distributed template without integrations", () => {
  const env = loadEnv(parseEnv(readFileSync(".env.example", "utf8")));
  expect(env.SONARR_URL).toBeUndefined();
  expect(env.RADARR_URL).toBeUndefined();
  expect(env.PROWLARR_URL).toBeUndefined();
  expect(env.SEARXNG_URL).toBeUndefined();
});
