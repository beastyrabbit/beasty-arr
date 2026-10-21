import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { createUploadProxy } from "./glitchtip-upload-proxy.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("rewrites absolute chunk URLs, overrides auth, and streams uploads to the fixed upstream", async () => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    if (request.method === "GET") {
      const body = JSON.stringify({ url: "https://sso.example/chunk-upload", chunkSize: 1024 });
      response
        .writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        })
        .end(body);
    } else response.writeHead(201).end("uploaded");
  });
  const target = await listen(upstream);
  const token = "synthetic-upstream-auth";
  const proxy = createUploadProxy({ target, token });
  const url = await listen(proxy);
  const pathname = "/api/0/organizations/beasty-rabbit/chunk-upload/";
  try {
    const options = await fetch(`${url}${pathname}`, {
      headers: { authorization: "Bearer client-value" },
    });
    assert.equal(options.status, 200);
    const json = await options.json();
    assert.equal(json.url, `${url}${pathname}`);
    assert.equal(json.chunkSize, 1024);
    const upload = await fetch(json.url, { method: "POST", body: Buffer.alloc(128_000, 42) });
    assert.equal(upload.status, 201);
    assert.equal(await upload.text(), "uploaded");
    for (const request of received) {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.headers.host, new URL(target).host);
      assert.equal(request.path, pathname);
    }
    assert.equal(received[1].body.length, 128_000);
    assert.equal(received[1].body[127_999], 42);
  } finally {
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  }
});
