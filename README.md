# beasty-arr

German-hunting companion for Sonarr and Radarr. The arrs only pick up releases via RSS at grab
time — German dubs that appear months later are never found unless something re-triggers a search.
beasty-arr is that something:

- **Hunts continuously**: loops over the whole library forcing missing + upgrade searches until
  every series and movie has a file with **German audio** (English/original is fine in the interim —
  your quality profiles decide what gets grabbed; beasty-arr only triggers searches and reads state).
- **Budget-aware**: a demand-adaptive controller keeps a low search trickle, forecasts the arrs'
  organic Prowlarr usage, and automatically ramps up to consume leftover daily indexer budget —
  never overrunning any indexer's cap.
- **AI Dub Oracle**: asks an LLM (Codex / local Ollama) with web verification whether a German dub
  even exists for a title; hopeless items are paused for months instead of wasting searches.
- **Fixer**: absorbed from the sonarr_fixer project — AI-assisted resolution of stuck import-queue
  items with deterministic validation and confidence-gated auto-apply.
- **Web GUI** (dark, dense, live via SSE), **Homepage widget** (`GET /api/status`), and a
  **dry-run mode that is ON by default** — nothing mutates your arrs until you flip it.

## Security

Auth is mandatory: the server refuses to start in production without `APP_API_KEY`, every route
except `/api/health` and login is auth-gated, and stored arr keys are never returned by any
endpoint. (Huntarr died of exactly this; we don't.)

## Development

```sh
pnpm install
cp .env.example .env   # fill in arr URLs + keys
portless beasty-arr    # -> http://beasty-arr.localhost:1355  (or: pnpm dev)
pnpm check             # biome + typecheck + vitest + build
```

Runs on Node 24, Fastify 5, SQLite (Drizzle), React 19 + Vite. Deployed to the homelab cluster via
Forgejo Actions → `git.heerlab.com/beasty/beasty-arr` → Flux (see kub-homelab `apps/media/beasty-arr`).
