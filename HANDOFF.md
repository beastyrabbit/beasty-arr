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
support, not a promised Ollama setting in the GUI. The Codex model list merges
Pi's built-in catalog with the pi.dev catalog cached in DATA_DIR/pi/models-store.json.
Only the Settings model list fetches pi.dev: at most every four hours after pi.dev
answers, but on every visit while it is unreachable (5 s timeout each). Inference
reads the cache offline.

Configured Prowlarr accounting must refresh successfully and have complete indexer
observations no older than five minutes. Force and manual Missing requests
explicitly bypass the automatic budget gate, but still record estimates.
Reservations survive refresh and restart until a terminal command and observed
queries support reconciliation, or confirmed completion is over 24 hours old and
history refresh succeeds. Ambiguous response loss or missing command IDs
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

The Fixer treats a download as its unit of work. Sonarr lists a season pack as
one queue row per episode; the Fixer merges those rows, records every queued
episode id on the analysis, locks one analysis per download, and validates the
apply against that recorded target set instead of whichever row Sonarr lists
first. Each file gets a deterministic upgrade decision (missing target, quality,
revision, custom format score, German audio added) that the AI sees in the
upgrade context and that the Sonarr preflight enforces; a selected file whose
upgrade cannot be verified from Sonarr's data is refused as well. Preflight now runs at
the end of analysis, so a refused import shows as needs review rather than as an
apply failure. After a partial pack import, leftovers that are verified
non-upgrades or samples are removed from the client without blocklisting;
anything else stays in the queue for review.

A revision (PROPER/REPACK) only outranks the exact same quality. Before 0.6.0 it
also outranked grouped siblings, so a 720p PROPER replaced 1080p files.

Since 0.6.0 the Fixer investigates instead of re-reading arr data
(src/server/fixer/inspection.ts, guards.ts, pi-media-tools.ts). It probes every
candidate and current library file (src/server/media/probe.ts), runs the arr's
independent parse of the release name, and shows both to the AI. The proposal
schema requires an identity verdict, the actual work, independent evidence, and
a written rationale. Deterministic guards turn an import or removal into
needs_review when those observations contradict it; the AI's confidence is not
used for that. Duplicates and non-upgrades are removed with blocklist and no
replacement search, which ends the regrab loops seen on 2026-10-03.

After 0.6.9 (review of 1265 applied actions and 360 traced analyses): the removal
guards held correct AI decisions more often than they stopped wrong ones. A removal
is no longer held when the candidate's arr quality is a lower source than the
library file at the same resolution (WEBDL-1080p against Remux-1080p), even if its
custom-format score is higher. A "different work" removal is backed when the release
year is earlier than the series' first year, or when the arr's parse matched no
library work and names an unrelated title; backing is only required when the
removal could lose German audio, an upgrade, or a target's only file. A removal that
asks for a new search although every queued target already has German is corrected
to skipRedownload=true with a warning instead of waiting for a person. Files that
ffprobe rejects as invalid data no longer count as possibly German. A PROPER/REPACK
of the same quality is an upgrade only when its custom-format score is not lower,
and the Radarr upgrade check and preflight now load the library file's real score
(/movie/{id} omits it). The AI prompt tells the Fixer that a profile-disallowed
quality can never be imported, that a non-upgrade may be removed with an uncertain
identity, and that a Dub Oracle "exists" verdict triggers a new search only when the
target has no library file (the arr's own search re-grabbed the same duplicate
repeatedly). Codex "overloaded" errors are retried and an attempt with no session
event for PI_STALL_TIMEOUT_MS (default five minutes) is aborted and retried.

Both arrs have Media Management "Propers and Repacks" set to prefer and upgrade, so
they grab PROPER/REPACK releases they then refuse to import as custom-format
downgrades; most "Not a Custom Format upgrade" queue items come from that. Setting it
to "do not prefer" in Sonarr and Radarr is an operator decision outside this repo.

Operator steps for 0.6.0: mount the media PVC read-only in the beasty-arr pod and
set FIXER_MEDIA_PATH_MAP (kub-homelab). Sonarr and Radarr keep replaced files in
/data/recycle/{sonarr,radarr} for 30 days (set 2026-10-03).

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
  history before resolving its persisted attempt. Do not release unresolved work
  merely because time elapsed. Use the recovery endpoint below for unknown IDs.
- Verify deployed revision, real Codex login, a dry-run soak, trusted ingress,
  deployed SSE reconnect, branch/tag protections, runner/BuildKit isolation and
  snapshot restoration in their owning environments. A repository PR does not
  establish these external controls.
- CI actions are pinned to immutable revisions. The registry-login action uses its
  authenticated GitHub mirror; its contents matched the local trusted checkout.

## Interrupted search recovery

Find affected IDs with `GET /api/attempts?status=interrupted`. Check command and
history records in the owning Arr before making a recovery decision. For an
interrupted attempt without an Arr command ID, send
`POST /api/hunt/attempts/<id>/resolve` with one of these JSON bodies:

```json
{"action":"attach_command","commandId":123,"note":"Verified matching targets and dispatch time in Arr","confirm":"verified_in_arr"}
```

```json
{"action":"confirm_not_accepted","note":"Verified Arr did not accept or execute this request","confirm":"verified_in_arr"}
```

Attaching a verified ID keeps reservations until ordinary reconciliation sees
the command finish. Confirming non-acceptance releases estimates and lets the
target participate in later planning. Neither action dispatches a search. The
endpoint rejects live cycles, already resolved attempts and attempts with a
known command ID. Recovery decisions are recorded in Activity. If acceptance is
still uncertain, leave the hold in place.

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
