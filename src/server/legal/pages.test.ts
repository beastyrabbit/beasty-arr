import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const paths = ["/impressum", "/datenschutz", "/legal-notice", "/privacy"];
let dataDir: string;
let built: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "beasty-arr-legal-"));
  built = await buildApp({
    env: { NODE_ENV: "production", LOG_LEVEL: "error" },
    dataDir,
    // Exercise actual static registration and SPA fallback, not just an isolated plugin.
    serveStatic: true,
    registerJobs: false,
  });
});

afterAll(async () => {
  await built.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("public legal pages", () => {
  it.each(paths)("serves %s as a self-contained, non-indexable HTML document", async (url) => {
    const response = await built.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).toContain('<meta name="robots" content="noindex">');
    expect(response.body).toContain('<meta name="viewport"');
    expect(response.body).toContain('<link rel="icon" href="data:,">');
    const german = url === "/impressum" || url === "/datenschutz";
    expect(response.body).toContain(`<html lang="${german ? "de" : "en"}">`);
    for (const line of [
      "Tobias Heer",
      "c/o Impressumservice Dein-Impressum",
      "Stettiner Str. 41",
      "35410 Hungen",
      german ? "Deutschland" : "Germany",
    ]) {
      expect(response.body).toContain(line);
    }
    const privacy = url === "/datenschutz" || url === "/privacy";
    expect(response.body).toContain(
      `${privacy ? "datenschutz" : "impressum"}-beasty-arr@heerlab.com`,
    );
    if (!privacy) {
      expect(response.body).toContain("https://beastyrabbit.com/kontakt?from=beasty-arr");
      expect(response.body).not.toContain("§ 18");
    }
    const otherLanguage = privacy
      ? german
        ? "/privacy"
        : "/datenschutz"
      : german
        ? "/legal-notice"
        : "/impressum";
    for (const href of [
      german ? "/impressum" : "/legal-notice",
      german ? "/datenschutz" : "/privacy",
      otherLanguage,
      "/",
    ]) {
      expect(response.body).toContain(`href="${href}"`);
    }
    expect(response.body).not.toMatch(
      /\bsrc\s*=|\bsrcset\s*=|<script\b|<iframe\b|<object\b|<embed\b|<link[^>]+stylesheet|@import|url\s*\(/i,
    );
    expect(response.body.match(/<link\b/g)).toHaveLength(1);
    expect(response.body).not.toContain("<!--");
    expect(response.body).not.toContain('id="root"');
    const slash = await built.app.inject({ method: "GET", url: `${url}/` });
    expect(slash.statusCode).toBe(200);
    expect(slash.body).toBe(response.body);
    expect(slash.headers["content-security-policy"]).toBe(
      response.headers["content-security-policy"],
    );
  });

  it.each(["/datenschutz", "/privacy"])(
    "numbers %s sections in order and discloses app processing",
    async (url) => {
      const response = await built.app.inject(url);
      const headings = [...response.body.matchAll(/<h2 id="([^"]+)">(\d+)\. /g)];
      expect(headings.map((match) => Number(match[2]))).toEqual(
        Array.from({ length: 16 }, (_, i) => i + 1),
      );
      expect(headings.map((match) => match[1])).toEqual([
        "controller",
        "overview",
        "hosting",
        "logs",
        "crowdsec",
        "sso",
        "app-data",
        "posters",
        "openai",
        "indexers",
        "public-sources",
        "email",
        "cookies",
        "rights",
        "provision",
        "changes",
      ]);
      for (const text of [
        "Pocket-ID",
        "artworks.thetvdb.com",
        "image.tmdb.org",
        "auth.openai.com",
        "query.wikidata.org",
        "Earendil Inc.",
        "ba.sidebar",
      ]) {
        expect(response.body).toContain(text);
      }
      expect(response.body).not.toMatch(/Umami|GlitchTip|Resend/);
    },
  );

  // Deliberate publication gate: keep this a normal failing test until the user verifies
  // the five named constants in content.ts. Do not skip or invert this assertion.
  it("has no unresolved placeholders in any rendered page", async () => {
    const pages = await Promise.all(paths.map((url) => built.app.inject(url)));
    expect(pages.flatMap((response) => response.body.match(/\[\[[^\]]+\]\]/g) ?? [])).toEqual([]);
  });

  it("keeps legal-only headers off API responses", async () => {
    const response = await built.app.inject("/api/health");
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-robots-tag"]).toBeUndefined();
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });
});
