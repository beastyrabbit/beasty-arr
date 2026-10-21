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
});
