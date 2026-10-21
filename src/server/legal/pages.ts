import type { FastifyInstance } from "fastify";
import { type LegalLanguage, legalNoticeSections, privacySections } from "./content.js";

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// These colors follow src/web/styles.css; public pages cannot load the app's fonts or CSS.
const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0e0f13; color: #e6e8ee; font: 15px/1.65 system-ui, sans-serif; }
  .column { max-width: 780px; margin: auto; padding: 24px 20px 48px; }
  header, footer { border-color: #262a33; border-style: solid; border-width: 0; }
  header { padding-bottom: 20px; border-bottom-width: 1px; }
  footer { margin-top: 40px; padding-top: 20px; border-top-width: 1px; }
  nav { display: flex; flex-wrap: wrap; gap: 8px 20px; }
  a { color: #f0a63a; text-underline-offset: 3px; overflow-wrap: anywhere; }
  a:hover { color: #e6e8ee; }
  a:focus-visible { outline: 2px solid #f0a63a; outline-offset: 4px; }
  .brand { color: #e6e8ee; font-weight: 600; text-decoration: none; }
  .brand span { color: #f0a63a; }
  h1 { font-size: clamp(1.8rem, 6vw, 2.4rem); line-height: 1.2; margin: 32px 0 16px; }
  h2 { font-size: 1.2rem; line-height: 1.4; margin: 32px 0 12px; }
  p, li { overflow-wrap: anywhere; }
  ul { padding-left: 24px; }
  .updated { color: #8b93a5; }
`;

function pageShell(language: LegalLanguage, privacy: boolean): string {
  const german = language === "de";
  const title = privacy
    ? german
      ? "Datenschutzerklärung"
      : "Privacy Policy"
    : german
      ? "Impressum"
      : "Legal Notice (Impressum)";
  const sections = privacy ? privacySections : legalNoticeSections;
  const content = sections
    .map((section, index) => {
      const { heading, body } = section[language];
      return `<section aria-labelledby="${section.id}"><h2 id="${section.id}">${privacy ? `${index + 1}. ` : ""}${heading}</h2>${body}</section>`;
    })
    .join("\n");
  const links = `<nav aria-label="${german ? "Rechtliche Informationen" : "Legal information"}">
    <a href="${german ? "/impressum" : "/legal-notice"}">${german ? "Impressum" : "Legal notice"}</a>
    <a href="${german ? "/datenschutz" : "/privacy"}">${german ? "Datenschutz" : "Privacy"}</a>
    <a href="${privacy ? (german ? "/privacy" : "/datenschutz") : german ? "/legal-notice" : "/impressum"}" lang="${german ? "en" : "de"}" hreflang="${german ? "en" : "de"}">${german ? "English" : "Deutsch"}</a>
    <a href="/">${german ? "Zur Anwendung" : "Back to app"}</a>
  </nav>`;
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <link rel="icon" href="data:,">
  <title>${title} · beasty-arr</title>
  <style>${STYLE}</style>
</head>
<body><div class="column">
  <header><a class="brand" href="/">beasty<span>-arr</span></a></header>
  <main><h1>${title}</h1>
  ${privacy ? `<p class="updated">${german ? "Stand: 21. Oktober 2026" : "Last updated: 21 October 2026"}</p>` : ""}
  ${content}
  </main><footer>${links}</footer>
</div></body>
</html>`;
}

export function registerLegalPages(app: FastifyInstance): void {
  for (const [url, language, privacy] of [
    ["/impressum", "de", false],
    ["/datenschutz", "de", true],
    ["/legal-notice", "en", false],
    ["/privacy", "en", true],
  ] as const) {
    const html = pageShell(language, privacy);
    // Explicit routes take precedence over both static files and the SPA not-found handler.
    for (const path of [url, `${url}/`]) {
      app.get(path, (_request, reply) =>
        reply
          .type("text/html; charset=utf-8")
          .header("X-Robots-Tag", "noindex")
          .header("Content-Security-Policy", CSP)
          // Revalidate on every visit so operator/contact corrections become visible promptly.
          .header("Cache-Control", "no-cache")
          .send(html),
      );
    }
  }
}
