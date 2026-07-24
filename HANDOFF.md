# beasty-arr — Engineering Handoff

Status as of commit `abcf656` (2026-07-24). ~28.7k LOC, 329 tests passing, `pnpm check`
(biome + typecheck + vitest + vite build) green. This document is the single source of truth for
the next engineer/AI to finish the project. Read the full design plan alongside it:
`/home/beasty/.claude/plans/we-are-building-a-federated-engelbart.md`.

---

## 1. What this app is

A self-hosted Huntarr successor for a homelab. Mission: **every Sonarr series and Radarr movie
should eventually end up with a downloaded file that has German audio.** English/original is an
acceptable interim state. The arrs only find releases via RSS at grab time, so German dubs that
appear months later are never found unless something re-triggers a search. beasty-arr does that,
continuously and budget-aware, and also absorbs the old `sonarr_fixer` tool (AI-assisted resolution
of stuck import-queue items).

Core product rules (do not violate):
- The app **only forces searches and reads arr state**. It never manages quality profiles or custom
  formats — the user's Sonarr/Radarr profiles are already configured German-first (TRaSH/PCJones
  style), so when a search runs the arr grabs/upgrades correctly on its own.
- "Done" = file exists AND has a German audio track.
- **Dry-run defaults ON.** Nothing is sent to Sonarr/Radarr/Prowlarr and no paid AI calls happen
  until the user explicitly turns it off.
- Security is first-class: Huntarr died from unauthenticated endpoints leaking every connected API
  key. Auth is mandatory, keys are never returned by any endpoint.

## 2. Stack & layout

Node 24, Fastify 5, SQLite via Drizzle (better-sqlite3), React 19 + Vite SPA, TanStack
Router/Query/Table, Tailwind v4, SSE for realtime. Pi framework (`@earendil-works/pi-*`) for AI via
Codex (gpt-5.5), with an Ollama "aibox" fallback. Biome + lefthook + gitleaks. pnpm, single package.

```
src/shared/         domain.ts (enums, LANGUAGE_ID_GERMAN, backoff ladder), api-types.ts (the
                    full REST + SSE contract the GUI is built against), fixer-types.ts
src/server/
  index.ts          bootstrap + first-boot full sync
  app.ts            buildApp() — composition root; constructs every service, registers scheduler jobs
  context.ts        AppContext / AppServices types
  config/           env.ts (zod env), settings.ts (DB-backed tuning knobs), engine-flag.ts (pause)
  db/               schema.ts (all tables), index.ts (createDb, WAL). Migrations in /drizzle
  auth/             service.ts (API key + sessions + webhook token), plugin.ts (global guard)
  events/           bus.ts (in-process EventBus feeding SSE + replay buffer)
  scheduler/        index.ts (in-process job runner, single-flight + jitter)
  arr/              sonarr-client.ts, radarr-client.ts (ported from sonarr_fixer), http-util.ts
                    (retry/timeout), sonarr-format.ts, sample.ts
  prowlarr/         client.ts
  budget/           manager.ts (demand-adaptive controller)
  sync/             service.ts (mirror sync), adapters.ts (client→port), arr-ports.ts (interfaces)
  hunt/             engine.ts (cycle/dispatch/verdict/force/pause), selection.ts (scoring/grouping),
                    state.ts (pure deriveState)
  ai/               providers.ts (Pi runner), codex-auth.ts (device login), models.ts,
                    existence-check.ts (Dub Oracle), oracle-service.ts, fixer-adapter.ts
  fixer/            service.ts, resolver.ts, bulk.ts, validation.ts, pi-*-tools.ts, history.ts,
                    events-map.ts, ai-port.ts
  http/routes/      one file per group; index.ts registers them; util.ts shared helpers
  stats/            maintenance.ts (daily stats snapshot + VACUUM INTO backup)
src/web/            Full SPA. pages/: Login, Dashboard, Library, SeriesDetail, MovieDetail, Hunt,
                    Fixer, FixerHistory, Activity, Settings. lib/: api, events (SSE), queries.
```

## 3. What is DONE and working (verified live)

Booted against the real Sonarr (`192.168.60.31:8989`) and Radarr (`192.168.60.32:7878`) in
production mode + dry-run, logged in through the GUI, and confirmed end-to-end:
- **Full mirror sync works.** Pulled the real library into SQLite: ~67k Sonarr episodes, ~8.4k
  Radarr movies, states derived correctly (german / non_german / missing / unreleased / unmonitored).
- **Hunt cycle works in dry-run.** First cycle selected upgrade candidates, correctly grouped ≥3
  same-season episodes into `SeasonSearch` (1 query), recorded `search_attempts` with `dry_run=1`,
  and sent nothing to Sonarr. Prioritisation favours recent releases (where German dubs lag).
- **Auth works.** Health + login are the only unauthenticated routes; everything else 401s without a
  key/session. Login → session cookie → authenticated GUI.
- **GUI renders and serves.** SPA served from `dist/web`, dashboard hero + state ribbon + budget
  panel + fixer/oracle summaries all render with live data. SSE endpoint connects.
- **Every route group implemented** (status, dashboard, library, items, hunt, budget, logs, ai,
  fixer, config, webhooks, diagnostics) with zod validation, 503 degradation, dry-run translation.
- **Security fix applied**: webhooks use an HMAC-derived webhook-only token (not APP_API_KEY), and
  the request logger redacts `?token=`.

Build/test: `pnpm check` green (biome, dual tsconfig typecheck, 329 vitest tests, vite build).

## 4. CRITICAL context about the review that produced Section 5

A 7-dimension adversarial review ran (each finding cross-examined by 3 skeptics; majority-refute =
dropped). **It ran out of Fable-5 credits partway through verification**, so ~85 of the verify
agents died. The workflow's "refuted" bucket therefore contains findings that were *never actually
examined* — their verifiers just crashed. **Do not treat the "rejected" list as cleared.** I
hand-verified the load-bearing ones myself (see §5B). Treat §5 as the real backlog.

## 5. OPEN WORK — bugs to fix (ranked)

### 5A. Already fixed by me (for the record)
- **German language id was 26 (= Arabic); real German is 4.** Verified against the live Sonarr
  `/api/v3/language`. Fixed in `src/shared/domain.ts` (commit `abcf656`). Detection previously only
  worked via the `name === "german"` fallback and false-matched Arabic files. A full reconcile
  recomputes `has_german`, so stored data self-heals. **The running dev server still has old data
  until the next full sync — trigger `POST /api/system/resync` or restart after pulling.**

### 5B. Confirmed real, NOT yet fixed — verifiers died, I re-verified by hand
These were in the tool's "rejected" bucket ONLY because their skeptic agents crashed on usage
limits. I confirmed each against the code/live instance:

1. **[HIGH] SSE `hunt.search.started` payload key mismatch.** Engine emits `command: cmd.name`
   (`hunt/engine.ts:445,479`) but the contract (`api-types.ts:699`) and GUI
   (`Dashboard.tsx:33,137`) read `commandName`. Dashboard "now hunting" + live feed render
   `undefined`. Fix: rename the emitted key to `commandName` (and check `hunt.search.result`).
2. **[HIGH] SSE `item.updated` payload key mismatch.** Engine/sync emit `targetId`
   (`engine.ts:984`, `sync/service.ts:367,469`) but contract (`api-types.ts:713`) + GUI
   (`queries.ts:123`) expect `id`. Live cache patches silently no-op → library/detail pages don't
   update live. Fix: emit `id` (keep `seriesId`), or change contract+GUI consistently.
3. **[HIGH] Dry-run "type live" confirmation not enforced server-side.** `hunt.ts:331`:
   `if (enabled === false && confirm !== undefined && confirm !== "live")`. Omitting `confirm`
   entirely bypasses it — a direct API call can disable dry-run (start real searches + AI spend)
   with no confirmation. GUI enforces it client-side only. Fix: require `confirm === "live"` when
   `enabled === false`.
4. **[HIGH] `languageCutoffNotMet` may not exist on Sonarr v4 episodefile.** `state.ts:115` computes
   `profile_blocked` for episodes from `languageCutoffNotMet === false`. If the field is absent, it's
   always `null` → the episode branch of profile_blocked is unreachable. **Must verify against a real
   Sonarr v4 `GET /api/v3/episodefile` response** (the field is documented for `/wanted/cutoff`
   records but not necessarily episodefile). Low blast radius (profile_blocked is a warning state),
   but decide and document.
5. **[HIGH] `FixerService.apply` re-validates without the known-episode-ids set.** The resolver
   accumulates `knownEpisodeIds` from the AI's lookups to allow AI episode-id overrides, but
   `apply()` re-validates without them (`fixer/service.ts:~578`), permanently blocking exactly those
   override imports. Compare with `sonarr_fixer/src/main/services/sonarr-client.ts` `applyImportProposal`
   which re-fetches `getKnownEpisodeIds`. Fix: re-derive/persist the known ids and pass them to the
   apply-time validation.
6. **[HIGH] Fixer "Stop all" cancels bulk runs, not running analyses.** GUI "Stop all"
   (`Fixer.tsx:95`) calls bulk/cancel, but individual `analyze()` runs (the ones the GUI actually
   starts) can't be mass-stopped. Wire "Stop all" to `fixer.cancelAll()`.
7. **[MEDIUM] Dry-run does not gate fixer AI analyses.** `analyze()` runs the Codex resolver with no
   `dryRun` guard (only `apply()` checks it). Debatable (analysis is read-only re: the arrs) but it
   **spends real Codex tokens** while the GUI implies dry-run makes no AI calls. Decide: either gate
   analyze in dry-run, or fix the GUI copy. The oracle (`oracle-service.ts`) already skips its batch
   in dry-run except manual recheck.

### 5C. Confirmed by the review's surviving adversarial verifiers (≥2 skeptics each)

**Budget / pacing (money path — an overrun gets indexers banned):**
1. **[HIGH] Anime `SeasonSearch` cost is massively under-estimated.** `selection.ts:194` prices any
   ≥3-episode season as `searchOps=1`; but Sonarr executes an anime season search as one search
   *per episode* (absolute numbering), so real cost is ~(episodes × title-variants) per indexer,
   10–25× the estimate. Both budget gates and the eager `huntQueries` attribution use the wrong
   number, so caps get blown and the excess is then mis-attributed as *organic*, poisoning the
   forecast for weeks. Anime backlogs are a core use case. Fix: price SeasonSearch by covered episode
   count when `seriesType==='anime'`, or exclude anime from season grouping.
2. **[HIGH] Failing budget refresh + empty indexers mirror = unbounded dispatch.** `engine.ts:~327`
   catches `budget.refresh()` errors and proceeds "gating on last known ledger" — but on a fresh/wiped
   DB with Prowlarr unreachable (wrong key), the mirror is empty, `estimateCommand` returns an empty
   map, `mayDispatch` trivially passes, and `recordDispatch` is a no-op. Every cycle dispatches
   `maxCommandsPerCycle` forever, ungated. Fix: fail-closed — hold when refresh fails AND the mirror
   is empty/stale.
3. **[MEDIUM] `refresh()` deletes pending self-estimates for still-executing commands.**
   `manager.ts:~174` deletes all `pendingSelfEstimates` with `at < now` assuming commands completed
   within the cycle; a command that times out (>10 min) or a mid-poll shutdown leaves the estimate
   deleted while the query hasn't landed yet → `trailing24h` under-counts → budget re-opened → burst
   when Sonarr drains. Fix: delete estimates only when the linked `search_attempts` row completed
   before the stats fetch began (and capture `now` before the fetch).
4. **[MEDIUM] Small-cap indexer deadlocks ALL hunting.** `manager.ts:~232`: `huntRatePerHour` is
   capped at `cap/budgetBurstMaxDivisor` (default 12). An indexer with `cap<60` gives `burstMax<5`,
   so a 5-id EpisodeSearch can never pass even at zero spend. On hold the engine `break`s the whole
   plan before any state write → same candidate re-selected forever → engine hunts nothing (both
   arrs). Fix: `continue` past the rejected command instead of `break`, and clamp batch size to fit
   the smallest gated indexer / surface guidance.
5. **[MEDIUM] Hunt attribution written for indexers the arr never queries.** `manager.ts:~196`
   attributes `huntQueries` to every category-matching indexer, but Prowlarr only forwards a Sonarr
   search to Sonarr-synced indexers; and on `sendCommand` throw the eager attribution isn't rolled
   back. Phantom `huntQueries` eat real organic in `organic = max(0, observed - hunt)`, shrinking the
   forecast and the safety headroom. Fix: attribute only to app-synced indexers; roll back on failure.

**Hunt engine / state machine:**
6. **[HIGH] Resume-with-force permanently un-schedules exhausted items.** `engine.ts:~1089`
   `resumeSubject({force:true})` sets `nextEligibleAt=null`, but `loadScheduledCandidates` skips
   exhausted rows with null `nextEligibleAt` and nothing repopulates it in dry-run. Item is never
   auto-searched again. Fix: set `nextEligibleAt=now` (or reset tier below EXHAUSTED_TIER) for
   exhausted rows on resume/force; same for `applyVerdict` 'exists'.
7. **[HIGH] `awaitingImportSince` cleared prematurely for upgrade grabs.** `sync/service.ts:~651`
   clears the "grab in flight" hold on bare `hasFile`, but upgrade targets already had a file, so any
   later sync touch wipes the hold mid-download → the item is re-searched while its German upgrade is
   still downloading (wasted budget, possible double-grab). This breaks the mechanism for the app's
   core upgrade loop. Fix: clear only when `fileImportedAt`/fileId changed since `awaitingImportSince`.
8. **[HIGH] Empty arr list response wipes the entire mirror + hunt state.** `sync/service.ts:~197`
   prunes with `notInArray(col, keepIds)`; drizzle compiles `notInArray(col, [])` to `TRUE`, so if
   `getSeries()`/`getMovies()` returns `[]` (wrong instance, proxy misroute, or the adapter dropping
   all records after an API shape change) the reconcile deletes every series/episode/movie/hunt_state
   row — tiers, pauses, searchCounts all unrecoverable. Fix: skip prune (log loudly) when the fetched
   list is empty while the mirror is non-empty; consider a >50% delete sanity guard.
9. **[MEDIUM] `lastSearchAt` stamped after the post-search refresh** (`engine.ts:~586`) → an import
   landing during command polling gets `fileImportedAt < lastSearchAt`, so the tier-reset-on-import
   is missed (tier increments → false "exhausted") and the dub-lag gate is bypassed. Fix: stamp
   `lastSearchAt` with the command's dispatch time, or refresh after writing hunt-state patches.
10. **[MEDIUM] Consecutive-unlikely AI pause doubling is dead code.** `engine.ts:~1004` doubles the
    pause only when `state==='ai_paused'` at re-verdict, but sync's `deriveState` uses
    `aiPausedUntilFor` (never the doubled horizon) and flips `ai_paused`→missing at the base horizon;
    the oracle only re-checks huntable rows, so `state` is never `ai_paused` at re-verdict. The
    180→365d escalation never fires → wasted searches + paid AI checks every ~180d forever. Fix:
    persist the applied pause horizon into the derive input; base doubling on the previous verdict.
11. **[MEDIUM] Budget rejection breaks the whole plan loop.** `engine.ts:~365` `setHold` + `break`
    abandons all remaining commands, including the *other* arr's commands whose indexers still have
    budget. Deterministic ordering means the same head command blocks everything until midnight. Fix:
    `continue` with a per-indexer/per-source hold set; break only when everything is blocked.
12. **[LOW] Nightly reconcile snapshots the verdict map before the paced walk** (`sync/service.ts:219`)
    → the 04:00 oracle job overlapping the 03:00 reconcile can have its fresh `ai_paused` clobbered
    back to missing for ~23h. Fix: reload verdict map per batch, or honor a future `nextEligibleAt` in
    `reconcileDerivedState`.
13. **[LOW] `huntTickMinutes` read once at startup** (`app.ts:164`) — settings change doesn't apply
    until restart, while `engineStatus()` advertises the new cadence. Fix: recompute the delay from
    settings inside the scheduler callback.

**Security:**
14. **[MEDIUM] `trustProxy: true` lets X-Forwarded-For spoofing defeat the login rate limit.**
    `app.ts:49` blanket-trusts proxies, so `req.ip` (the only bucket key for the 10/min login limiter)
    is attacker-controlled → unlimited brute-force against a ≥16-char `APP_API_KEY`. Fix: scope
    `trustProxy` to the known proxy subnet, or key the rate limiter on `req.socket.remoteAddress`.
    Consider a minimum-entropy floor on `APP_API_KEY`.

### 5D. Findings the review genuinely refuted (do NOT act on these)
The following were examined by ≥2 surviving skeptics and refuted — listed so you don't re-chase them:
hour-rollover organic misclassification; dispatch-failure hot-loop; force-swallowed-while-in-flight;
`expireAwaitingImports` overwriting backoffs; Prowlarr `limitsUnit` hourly/daily; `downloadFailed`
history handling; indexerstats monotonicity; history-cursor-before-processing; GUI verdict invalidate
copy; fixer live-log duplication; dashboard now-hunting-never-clears; manual verdict recheck; fixer
event stream tool args; VITEST guard coverage of codex login. (Several of these are cosmetic; if you
have spare cycles, the "manual verdict recheck destroys the verdict even when recheck never runs"
and "GUI Re-check never passes ?recheck=true" pair is worth a second look — they were refuted but are
low-confidence refutes.)

## 6. NOT STARTED — remaining milestones

**M6 Deployment (nothing done yet).** All artifacts still to create:
- App repo CI already exists (`.forgejo/workflows/ci.yaml`, Dockerfile) but has never run. Push to
  `git.heerlab.com/beasty/beasty-arr` and confirm the Forgejo build + image push works.
- kub-homelab manifests (in the `kub-homelab` repo, `cluster/homelab/apps/media/beasty-arr/`):
  `helmrelease.yaml` (bjw-s app-template 5.0.1, copy qa-council's hardened securityContext,
  ClusterIP `10.96.0.118:9898`, longhorn 2Gi PVC at `/data`), `infisical-sync.yaml` (copy
  `apps/media/umlautadaptarr/infisical-sync.yaml`, template `SONARR_API_KEY`/`RADARR_API_KEY`/
  `PROWLARR_API_KEY`/`APP_API_KEY`), `kustomization.yaml` + entry in `apps/media/kustomization.yaml`.
- Pangolin blueprint entry in `config/blueprints/media.yaml`: `beasty-arr.heerlab.com`, ssl, SSO role
  `BeastyOnly`, target `10.96.0.118:9898`, healthcheck `/api/health`. **Verify SSE passes through
  Pangolin unbuffered** (the events endpoint already sets `x-accel-buffering: no`).
- Homepage tile in `apps/homepage/config/services.yaml` (copy the Clonarr customapi tile):
  `url: http://10.96.0.118:9898/api/status`, header `X-Api-Key: {{HOMEPAGE_VAR_BEASTY_ARR_KEY}}`,
  mappings germanPct/missingGerman/huntsToday/budgetUsedPct.
- `docs/ip-registry.md` row for `.118` and the app list in kub-homelab CLAUDE.md.
- **One manual step (blocking):** add `HOMEPAGE_VAR_BEASTY_ARR_KEY` (random) to Infisical project
  `71562e7f-98e6-45f1-a031-ca8713b3f0dd`, env `prod`, path `/kubernetes/homepage/homepage-secrets`.
  This value becomes both `APP_API_KEY` and the homepage widget key. (I confirmed the SONARR/RADARR/
  PROWLARR keys already exist at that path; BEASTY_ARR does not.)

**Codex auth in the pod (design decided, not exercised).** `ai/providers.ts` persists Pi credentials
at `$DATA_DIR/pi/auth.json` on the PVC; first-run seeding is via the web device-login flow
(`POST /api/ai/codex-login/start` → poll → show verificationUri+userCode in Settings→AI). This has
NOT been run against real Codex yet — `/api/ai/status` currently reports `unauthenticated`. The
pi-coding-agent 0.80 API differs from the 0.75 reference (`AuthStorage` no longer exported → a
`FileCredentialStore` was written; `ModelRuntime.login` replaces `authStorage.login`). Verify the
device-login round-trips against real Codex before relying on the oracle/fixer AI.

**Post-deploy validation plan:** health probes green → homepage tile renders → SSE live through
Pangolin → run ~1 week in dry-run and eyeball `search_attempts` + `budget_buckets` pacing → then flip
dry-run off and do one manually-forced live search on a known item as acceptance.

## 7. Local dev / running it

```
pnpm install
cp .env.example .env    # fill SONARR_URL/KEY, RADARR_URL/KEY, PROWLARR_URL/KEY, APP_API_KEY (>=16)
pnpm build              # required for production static serving; SPA lands in dist/web
NODE_ENV=production PORT=9898 pnpm start   # or: pnpm dev for tsx watch + vite proxy
pnpm check              # biome + typecheck + vitest + build (the CI gate)
```
There is a working local `.env` (gitignored) pointing at the real Sonarr/Radarr LB IPs with keys
pulled from Infisical. Prowlarr is ClusterIP-only (not reachable from the workstation) so the budget
manager reports "unknown"/no indexers in local runs — that's expected off-cluster, not a bug.

Notes for the next engineer:
- Server ESM imports MUST end in `.js` (NodeNext). Tests are colocated `*.test.ts`, node env, never
  hit live network/AI (there's a hard VITEST guard in `ai/providers.ts`; inject fakes).
- Static serving + migrations resolve via `process.cwd()` (repo root in dev, `/app` in the container).
- The `sonarr_fixer` project (`/mnt/storage/workspace/projects/sonarr_fixer`) is the reference for all
  ported fixer/arr code — consult it for port-fidelity questions (esp. `applyImportProposal`).

## 8. Suggested order of work for the finisher

1. Fix the §5B contract-drift bugs first (1–3, 6) — they're small, verified, and make the GUI/live
   updates actually correct. Fix the §5B dry-run confirm (3) since it's a safety gate.
2. Fix the §5C budget HIGHs (1, 2) and engine-state HIGHs (6, 7, 8) — these are the ones that can
   damage indexers or destroy state once dry-run is off. Do NOT flip dry-run off in production until
   these land.
3. Verify §5B item 4 (`languageCutoffNotMet`) against a real Sonarr v4 response.
4. Work the remaining §5C mediums/lows.
5. Then M6 deployment, then the Codex device-login verification, then the dry-run soak + go-live.
