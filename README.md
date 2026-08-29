# beasty-arr

German-hunting companion for Sonarr and Radarr. The arrs only pick up releases via RSS at grab
time — German dubs that appear months later are never found unless something re-triggers a search.
beasty-arr is that something:

- **Hunts continuously**: loops over existing non-German files and forces German upgrade searches
  until every series and movie has **German audio**. Missing episodes are handled separately in the
  manual Missing workspace, where completeness matters and audio language does not.
- **Budget-aware**: a demand-adaptive controller keeps a low search trickle, forecasts the arrs'
  organic Prowlarr usage, and automatically ramps up to consume leftover daily indexer budget —
  automatic hunts never overrun an indexer's cap. Explicit Force and manual Missing searches run
  immediately and intentionally bypass that automatic budget gate.
- **AI Dub Oracle**: asks an LLM (Codex / local Ollama) with web verification whether a German dub
  even exists for a title; confident negative seasons are paused for at least a year.
- **Fixer**: absorbed from the sonarr_fixer project — AI-assisted resolution of stuck import-queue
  items with deterministic validation and confidence-gated auto-apply.
- **Web GUI** (dark, dense, live via SSE), **Homepage widget** (`GET /api/status`), and a
  **dry-run mode that is ON by default** — nothing mutates your arrs until you flip it.

## Security

The application intentionally has no user login or API-key guard; every API route is reachable by
clients that can reach the service. Connected arr keys are still never returned by any endpoint,
and webhook callbacks use a dedicated capability token. Put the deployment behind a trusted network
or an external access-control layer if exposure requirements change.

## Development

```sh
pnpm dev
```

That single command starts API + Vite through Portless and injects the dev connection settings from
the `beasty-arr` Infisical project. It also opens a local Kubernetes port-forward so the budget
controller can read Prowlarr. Open the `.localhost` URL printed by Portless. Local development is
hard-locked to dry-run: it performs real library reads and hunt planning, but refuses to send commands
or mutations to Sonarr or Radarr. Set `SONARR_EXTERNAL_URL` and `RADARR_EXTERNAL_URL` to the
browser-reachable arr origins to show direct title links in the library. Use `pnpm check` for the
full local quality suite.

Runs on Node 24, Fastify 5, SQLite (Drizzle), React 19 + Vite. Deployed to the homelab cluster via
Forgejo Actions → `git.heerlab.com/beasty/beasty-arr` → Flux (see kub-homelab `apps/media/beasty-arr`).
