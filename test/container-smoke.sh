#!/usr/bin/env bash
set -euo pipefail
image="${1:?Pass the locally built image tag}"
name="beasty-arr-smoke-$$"
cleanup() { docker rm --force "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --name "$name" --network none \
  --env BEASTY_ARR_FORBID_LIVE_AI=1 --tmpfs /data:rw,uid=1000,gid=1000 "$image" >/dev/null
docker exec "$name" node --input-type=module -e '
  for (let i = 0; i < 100; i++) {
    try {
      const health = await fetch("http://127.0.0.1:9898/api/health");
      if (health.ok) {
        const { readdirSync, readFileSync } = await import("node:fs");
        const version = await fetch("http://127.0.0.1:9898/api/version");
        const body = await version.json();
        const expected = JSON.parse(readFileSync("/app/package.json", "utf8")).version;
        if (version.status !== 200 || version.headers.get("cache-control") !== "no-store" ||
            JSON.stringify(body) !== JSON.stringify({ version: expected })) {
          throw new Error("Version endpoint must expose only the package version without caching");
        }
        function assertNoMaps(directory) {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.endsWith(".map")) throw new Error("Runtime source map exposed");
            if (entry.isDirectory()) assertNoMaps(`${directory}/${entry.name}`);
          }
        }
        assertNoMaps("/app/dist");
        const assets = readdirSync("/app/dist/web/assets").filter(file => file.endsWith(".js"));
        if (!assets.length) throw new Error("No browser assets");
        for (const asset of [assets[0], "missing.js"]) {
          const response = await fetch(`http://127.0.0.1:9898/assets/${asset}.map`);
          if (response.status !== 404) throw new Error("Source map endpoint must return 404");
        }
        const Database = (await import("better-sqlite3")).default;
        const db = new Database("/data/beasty-arr.db", { readonly: true });
        if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("SQLite integrity failed");
        const columns = db.pragma("table_info(pending_self_estimates)");
        if (!columns.some(column => column.name === "reconciled_at")) throw new Error("Migration missing");
        db.close();
        console.log("Container startup, migrations, SQLite integrity and health passed");
        process.exit(0);
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  process.exit(1);
'
docker stop --time 25 "$name" >/dev/null
test "$(docker inspect "$name" --format '{{.State.ExitCode}}')" = 0
