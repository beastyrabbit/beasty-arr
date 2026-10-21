export type ClientConfig = {
  umami: { src: string; websiteId: string; domains: string[] } | null;
  glitchtip: { dsn: string; environment: string; release: string; tracesSampleRate: number } | null;
};

const PRIVATE_KEY =
  /authorization|cookie|api[-_]?key|token|password|secret|email|^user$|^ip_address$/i;
const EMAIL_TOKEN = /[\w.+@-]+/g;
const EMAIL_SUFFIX = /\.[a-z]{2,}/gi;
const BEARER = /\bBearer\s+[^\s"'<>;,]+/gi;
const CREDENTIAL = /((?:api[-_]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s&;,"'<>]+/gi;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const QUERY = /[?&][^&#\s]*/g;
const LOCAL_PATH = /\/(?:home|Users)\/[^/\s]+/g;
const QUERY_OR_FRAGMENT = /[?#]/;
const ROUTE_ID = /\/(?:\d+|[a-f\d]{8}-[a-f\d-]{27,})(?=\/|$)/gi;
const OPAQUE_ROUTE_ID = /(\/analyses\/|\/codex-login\/)[^/]+/g;

function scrubEmailToken(token: string): string {
  const parts = token.split("@");
  const output = [parts[0] ?? ""];
  for (const part of parts.slice(1)) {
    const domain = part.split("+", 1)[0] ?? "";
    let end = 0;
    // Require a domain character before the final dot, as the original pattern did.
    for (const match of domain.slice(1).matchAll(EMAIL_SUFFIX))
      end = match.index + 1 + match[0].length;
    const local = output.pop() ?? "";
    if (local && end > 0) output.push("[redacted-email]", part.slice(end));
    else output.push(local, "@", part);
  }
  return output.join("");
}

function scrubQuery(query: string): string {
  let start = 0;
  while (start >= 0) {
    const equals = query.indexOf("=", start + 1);
    if (equals === -1) break;
    if (equals > start + 1) return `${query.slice(0, equals + 1)}[redacted]`;
    // An empty key can precede another query marker in arbitrary error text.
    start = query.indexOf("?", equals + 1);
  }
  return query;
}

/** Keep route structure, never a title ID, search term, fragment, or capability token. */
export function telemetryPath(value: string): string {
  const path = value.split(QUERY_OR_FRAGMENT, 1)[0] ?? "/";
  return path.replace(ROUTE_ID, "/:id").replace(OPAQUE_ROUTE_ID, "$1:id");
}

export function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = telemetryPath(url.pathname);
    return url.toString();
  } catch {
    return telemetryPath(value);
  }
}

/** The same final privacy boundary for errors, traces, and breadcrumbs. */
export function createTelemetryScrubber(secrets: readonly string[] = []) {
  const exact = secrets
    .filter((value) => value.length > 0)
    .flatMap((value) => [value, encodeURIComponent(value)]);
  function scrubText(value: string): string {
    let text = value;
    for (const secret of exact) text = text.replaceAll(secret, "[redacted]");
    return text
      .replace(URL_PATTERN, scrubUrl)
      .replace(QUERY, scrubQuery)
      .replace(BEARER, "Bearer [redacted]")
      .replace(CREDENTIAL, "$1[redacted]")
      .replace(EMAIL_TOKEN, scrubEmailToken)
      .replace(LOCAL_PATH, "/[redacted-home]");
  }
  function scrub<T>(value: T): T {
    const seen = new WeakSet<object>();
    function visit(item: unknown, depth: number, context = ""): unknown {
      if (typeof item === "string") return scrubText(item);
      if (item === null || typeof item !== "object") return item;
      if (depth > 20 || seen.has(item)) return "[redacted]";
      seen.add(item);
      if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        // Request bodies, user identities, and AI prompts/tool results have no diagnostic value here.
        if (key === "user") continue;
        if (context === "request" && ["data", "body", "cookies", "query_string"].includes(key))
          continue;
        out[key] = PRIVATE_KEY.test(key) ? "[redacted]" : visit(entry, depth + 1, key);
      }
      return out;
    }
    return visit(value, 0) as T;
  }
  return scrub;
}
