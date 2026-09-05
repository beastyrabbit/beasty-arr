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
