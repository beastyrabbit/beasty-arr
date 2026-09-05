# Implementation status

Updated 5 September 2026 against the whole-project review of version 0.4.20.
The Schaffa review is the issue source. This file describes current behavior and
operator follow-ups, replacing the obsolete July worktree backlog.

## Current behavior

Automatic hunts recheck current dry-run and global pause before each new command.
Commands already accepted by Sonarr or Radarr can still finish. Dry-run continues
library reads and planning. Explicit human Oracle rechecks and Fixer analysis may
use AI in dry-run. Local development remains locked against Arr mutations.
The exposed AI configuration is Codex-only. The internal aibox adapter is legacy
support, not a promised Ollama setting in the GUI.

Configured Prowlarr accounting must refresh successfully and have complete indexer
observations no older than five minutes. Force and manual Missing requests
explicitly bypass the automatic budget gate, but still record estimates.
Reservations survive refresh and restart until a terminal command and observed
queries support reconciliation. Ambiguous response loss or missing command IDs
hold targets for operator investigation; no automatic mutation replay occurs.
Without a configured Prowlarr integration there is no budget accounting.

Oracle season refreshes preserve untouched unexpired entries and their dates.
Official evidence must identify the requested work and exact season. Missing
positive proof becomes unknown with a short retry, never a manufactured
high-confidence negative. Historical rows remain available.

Fixer review selections belong to one analysis. Review buttons and library title
links support keyboard navigation. Query failures display Retry; cached rows remain
visible with a refresh-failure notice. Disc-stream imports are rejected during
shared validation and client preflight.

The test suite denies unexpected network calls, constructs apps without ambient
connections, skips development auth seeding, and typechecks backend fixtures.
No automated test calls a live AI provider.

## Setup and operations

Copy .env.example for an unconfigured local startup, then supply each integration's
URL and key together through your secret manager. The existing pnpm dev command
still uses Infisical and the homelab port-forward. For a fixture-free offline start,
build and run with NODE_ENV=production and a new DATA_DIR.

The API intentionally has no login or API-key guard. Every reachable client can
control it; restrict access through the trusted network or external access layer.
There is no loopback authentication bypass.

Backups are created beside the completed backup and renamed only after VACUUM
finishes. Shutdown stops new scheduled work, cancels analyses and waits up to ten
seconds per drain stage before closing SQLite. A timed-out drain fails process
shutdown rather than closing SQLite under active work.
/api/health proves process liveness only, not integration readiness.

## Operator decisions and external acceptance

- Review active verdicts produced by dub-oracle-v15 or earlier before choosing
  exact titles/seasons to recheck. This implementation does not bulk-clear live
  verdicts or spend provider credits.
- For an interrupted search with unknown acceptance, inspect the Arr command and
  history before resolving its persisted attempt. Do not delete its reservation
  merely because time elapsed.
- Verify deployed revision, real Codex login, a dry-run soak, trusted ingress,
  deployed SSE reconnect, branch/tag protections, runner/BuildKit isolation and
  snapshot restoration in their owning environments. A repository PR does not
  establish these external controls.
- CI actions are pinned to immutable revisions. The registry-login action uses its
  authenticated GitHub mirror; its contents matched the local trusted checkout.

## Sonarr compatibility evidence

Sonarr v4.0.17.2952 EpisodeFileResource exposes QualityCutoffNotMet and
CustomFormatScore, but no LanguageCutoffNotMet:
https://github.com/Sonarr/Sonarr/blob/v4.0.17.2952/src/Sonarr.Api.V3/EpisodeFiles/EpisodeFileResource.cs

The combined-cutoff branch therefore remains conservative when language cutoff
metadata is absent. An explicit upgradeAllowed=false still blocks a profile.
A deployed version or sanitized response must be checked before changing that
fallback.

## Historical context

The former July handoff listed 326 tests and an unavailable external design plan.
Its authentication description and several bug reports had already become stale.
Use the Git history to consult that document; it is not the current backlog.
