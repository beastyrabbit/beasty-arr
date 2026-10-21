// biome-ignore-all lint/security/noSecrets: Synthetic credentials exercise scrubbing, not real accounts.
import { describe, expect, it } from "vitest";
import { createTelemetryScrubber, scrubUrl, telemetryPath } from "./telemetry.js";

describe("telemetry privacy", () => {
  it("scrubs nested headers, query strings, userinfo, emails, bearer and exact environment keys", () => {
    const scrub = createTelemetryScrubber(["fixture-arr-secret", "fixture-opaque-webhook"]);
    const event = {
      request: {
        url: "https://user:pass@arr.example/api/12?apikey=hidden&token=capability#secret",
        headers: {
          "X-Api-Key": "hidden",
          apikey: "hidden",
          api_key: "hidden",
          token: "hidden",
          Authorization: "Bearer hidden",
          Cookie: "session=hidden",
          Accept: "application/json",
        },
        data: { prompt: "private media details" },
        cookies: { session: "hidden" },
        query_string: "token=hidden",
      },
      exception: {
        values: [
          {
            value:
              "person@example.com Bearer abc.def fixture-arr-secret fixture-opaque-webhook token=capability https://name:pass@arr.example/?q=title",
          },
        ],
      },
      spans: [
        {
          data: {
            "http.request.header.x-api-key": "hidden",
            "http.url": "https://u:p@arr.example?api_key=hidden",
          },
        },
      ],
      user: { email: "person@example.com", ip_address: "192.0.2.1" },
    };
    const result = scrub(event);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "hidden",
      "capability",
      "person@example.com",
      "abc.def",
      "fixture-arr-secret",
      "fixture-opaque-webhook",
      "name:pass",
      "user:pass",
      "private media details",
      "192.0.2.1",
    ])
      expect(serialized).not.toContain(secret);
    expect(result.request.headers.Accept).toBe("application/json");
    expect(result).not.toHaveProperty("user");
    expect(result.request.url).toBe("https://arr.example/api/:id");
    expect(event.request.headers["X-Api-Key"]).toBe("hidden");
  });

  it("handles encoded keys, cycles, relative queries and route templates", () => {
    const scrub = createTelemetryScrubber(["a/b+c"]);
    expect(scrub("a%2Fb%2Bc /api/webhooks/sonarr?token=capability")).not.toContain("capability");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(scrub(cyclic)).toEqual({ self: "[redacted]" });
    expect(telemetryPath("/api/fixer/analyses/random-id/apply?secret=yes")).toBe(
      "/api/fixer/analyses/:id/apply",
    );
    expect(scrubUrl("/library/series/123?q=title#name")).toBe("/library/series/:id");
  });

  it.each([
    ["one+tag@sub.example.co.uk", "[redacted-email]"],
    ["person@example.com123", "[redacted-email]123"],
    ["abc@domain+other@example.com", "abc@[redacted-email]"],
    ["abc@a.com@b.com", "[redacted-email]@b.com"],
    ["abc@.com", "abc@.com"],
    ["?=keep?key=private&next=hidden#fragment", "?=keep?key=[redacted]&next=[redacted]#fragment"],
    ["??key=private", "??key=[redacted]"],
    ["?=keep?=also-kept", "?=keep?=also-kept"],
  ])("preserves scrubber edge cases for %s", (value, expected) => {
    expect(createTelemetryScrubber()(value)).toBe(expected);
  });

  it.each([
    "a.".repeat(25_000),
    "a@".repeat(25_000),
    "?".repeat(50_000),
    `a@${"a".repeat(50_000)}`,
  ])("scrubs 50k adversarial characters within 100 ms (%#)", (value) => {
    const scrub = createTelemetryScrubber();
    const start = performance.now();
    const result = scrub(value);
    expect(performance.now() - start).toBeLessThan(100);
    expect(result).toBe(value);
  });

  it("redacts long valid emails and query values without truncating keys", () => {
    const scrub = createTelemetryScrubber();
    expect(scrub(`person@${"a.".repeat(25_000)}com`)).toBe("[redacted-email]");
    const key = "?".repeat(50_000);
    expect(scrub(`${key}=private`)).toBe(`${key}=[redacted]`);
  });
});
