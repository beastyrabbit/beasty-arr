import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHUNK_OPTIONS = /^\/api\/0\/organizations\/[^/]+\/chunk-upload\/?$/;
const TRAILING_SLASH = /\/$/;
const OPTIONAL_TRAILING_SLASH = /\/?$/;
const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function forwardHeaders(headers) {
  const result = { ...headers };
  for (const name of [...HOP_HEADERS, ...(headers.connection ?? "").split(",")])
    delete result[name.trim().toLowerCase()];
  return result;
}

/** CI-only adapter for GlitchTip's absolute, unauthenticated chunk-upload URL. */
export function createUploadProxy({ target, token }) {
  const base = new URL(target);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || !token)
    throw new Error("A valid upload target and GLITCHTIP_AUTH_TOKEN are required");
  const transport = base.protocol === "https:" ? https : http;
  return http.createServer((request, response) => {
    const fail = () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end("Upload upstream failed");
    };
    const headers = forwardHeaders(request.headers);
    headers.host = base.host;
    headers.authorization = `Bearer ${token}`;
    headers["accept-encoding"] = "identity";
    const upstream = transport.request(
      `${base.origin}${base.pathname.replace(TRAILING_SLASH, "")}${request.url}`,
      { method: request.method, headers },
      (incoming) => {
        incoming.on("error", fail);
        const outgoing = forwardHeaders(incoming.headers);
        if (
          request.method !== "GET" ||
          !CHUNK_OPTIONS.test(request.url?.split("?")[0] ?? "") ||
          incoming.statusCode !== 200
        ) {
          response.writeHead(incoming.statusCode ?? 502, outgoing);
          incoming.pipe(response);
          return;
        }
        const chunks = [];
        let length = 0;
        incoming.on("data", (chunk) => {
          length += chunk.length;
          if (length > 1024 * 1024) incoming.destroy(new Error("Options response too large"));
          else chunks.push(chunk);
        });
        incoming.on("end", () => {
          try {
            const options = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const pathname = request.url.split("?")[0].replace(OPTIONAL_TRAILING_SLASH, "/");
            options.url = `http://127.0.0.1:${response.socket.localPort}${pathname}`;
            const body = JSON.stringify(options);
            delete outgoing["content-encoding"];
            delete outgoing.etag;
            outgoing["content-length"] = Buffer.byteLength(body);
            response.writeHead(200, outgoing).end(body);
          } catch {
            fail();
          }
        });
      },
    );
    upstream.on("error", fail);
    upstream.setTimeout(120_000, () => upstream.destroy());
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.GLITCHTIP_UPLOAD_TARGET) throw new Error("GLITCHTIP_UPLOAD_TARGET is required");
  const server = createUploadProxy({
    target: process.env.GLITCHTIP_UPLOAD_TARGET,
    token: process.env.GLITCHTIP_AUTH_TOKEN,
  });
  server.on("error", () => {
    process.stderr.write("Upload proxy could not listen\n");
    process.exitCode = 1;
  });
  server.listen(Number(process.env.GLITCHTIP_UPLOAD_PORT || 0), "127.0.0.1", () => {
    process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit()));
}
