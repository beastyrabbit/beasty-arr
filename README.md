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
- **AI Dub Oracle**: asks Codex with web verification whether a German dub
  even exists for a title; confident negative seasons are paused for at least a year.
- **Fixer**: absorbed from the sonarr_fixer project — AI-assisted resolution of stuck import-queue
  items with deterministic validation and confidence-gated auto-apply.
- **Web GUI** (dark, dense, live via SSE), **Homepage widget** (`GET /api/status`), and a
  **dry-run mode that is ON by default** — nothing mutates your arrs until you flip it.

Dry-run still performs library reads and planning. Explicit Oracle rechecks and Fixer analysis
can call AI while dry-run is enabled. Commands already accepted by an Arr can finish after
dry-run is turned on. Ambiguous command responses hold targets until acceptance is reconciled.

Fixer auto-run and Run all retry failed analyses after a cooldown starting at 15 minutes,
doubling up to six hours. Provider usage limits pause new Fixer analyses for one hour.
Auto-apply reanalyzes eligible saved proposals against current queue and library evidence before
applying them, even with auto-run off. Failed applications appear in the queue with their error
and a reanalysis/retry action. Manual review remains required below the configured confidence
thresholds or when no usable import candidates are available.

For an unconfigured local start, copy `.env.example`, run `pnpm build`, then
`NODE_ENV=production pnpm start`. Optional integrations are omitted in the template.
Supply both the URL and key for each integration through your secret manager.
See [HANDOFF.md](HANDOFF.md) for current behavior and operator acceptance work.

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
GitHub Actions on `arc-beasty-arr` → `ghcr.io/beastyrabbit/beasty-arr` → Flux. Publish a `v*` release
tag, then pin its image tag and digest in kub-homelab
`cluster/homelab/apps/media/beasty-arr/helmrelease.yaml` and reconcile Flux.
Deployments should set `SONARR_EXTERNAL_URL` and `RADARR_EXTERNAL_URL` to the HTTPS origins users
open in their browsers. These public URLs contain no API keys and are separate from the internal arr
connection URLs.
