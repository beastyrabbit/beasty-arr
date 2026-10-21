# Verification

Run `pnpm check` for format, lint, types, dead code, isolated runtime tests and the
production build. Tests reject unexpected network access and do not inherit Arr
connections or seed development credentials. Backend test fixtures are included
in the no-emit compiler configuration.

Build a local image, then run `bash test/container-smoke.sh <image-tag>`. The check
starts the image without networking, checks migration columns, opens SQLite for
an integrity check, requests liveness inside the container and sends SIGTERM.
The runtime suite also sends SIGTERM to a child process with a scheduled job in
flight and verifies the job finishes its database access before SQLite closes.

`browser-review.mjs` is a manual browser helper, not part of `pnpm check` or CI.
It requires a separately supplied Playwright runtime, such as the browser tool
used to capture this PR's evidence. It exports `verifyReviewFlows(page, baseUrl, evidenceDir)` for a
Playwright Page. Serve the production build from an isolated application with
`registerJobs: false`, no integration environment and a new temporary data
directory. The verifier installs synthetic queue, analysis, apply and Missing
responses and a fake EventSource. It checks keyboard review, cached proposal
selection isolation, the exact apply request, error versus empty states, Retry,
and a stale-cache refresh after SSE reconnect. Its screenshots contain fixture
data only. Use a context with video recording to capture the interaction.

`browser-fixer-recovery.mjs` exports `verifyFixerRecovery(page, baseUrl, evidenceDir)` for the
same isolated fixture app. It checks apply-error badges, provider cooldown messages, the 95%
removal gate, and the exact requests sent by Retry analysis, Reanalyze and retry, and Run all.

Legal-page route tests use Fastify inject with static serving enabled to check route precedence,
headers, both languages, cross links, trailing slashes and the absence of resource dependencies.
The jsdom layout test checks all four footer links during a query error. The normal test
`has no unresolved placeholders in any rendered page` checks all four rendered pages.
Privacy route tests also check the grouped processing sections and stated retention.
Run the focused tests with `pnpm exec vitest run src/server/legal/pages.test.ts src/web/components/Layout.test.tsx`.

After building, run `node test/browser-legal.mjs` for an isolated local verification with
Playwright Chromium. It prints the temporary screenshot directory. The helper also
exports `verifyLegalPages(page, baseUrl, evidenceDir)` for the same separately
supplied Playwright runtime. Build first, then serve via `buildApp({ env: { NODE_ENV: "test" },
dataDir: <fresh temporary directory>, serveStatic: true, registerJobs: false })` with integration
environment variables cleared and `BEASTY_ARR_FORBID_LIVE_AI=1`. The empty local database supplies
the dashboard without Sonarr/Radarr; no credentials or live AI are needed. The helper blocks all
external requests, stubs EventSource as the other browser helpers do, follows all four footer
links and policy cross links at 1280×800 and 390×844, checks not-found/query-error/route-error footers,
browser storage and legal-page resource requests, and checks the pages with JavaScript disabled.
It saves desktop/mobile home and all four legal-page screenshots to the supplied evidence directory.

The optional profiling checks count writes for a 1,000-delta Fixer stream and
check overlapping incremental history cutoffs against periodic full-day reads.
The title-history regression seeds over 400 unrelated searches. Route splitting
produced a 330.46 kB entry bundle in the implementation run, compared with the
review's single 644.43 kB bundle. Shared chunks and lazy page chunks still load
when needed; these sizes are not browser latency measurements.

A local synthetic detail benchmark compared the review base with this change,
using 50 warm requests for one series with ten seasons. At 1,000 library titles,
database reads per request fell from 33 to 13 and returned rows from 11,035 to 46.
Median request time fell from 13.7 ms to 0.8 ms. At one library title, the new
median was 0.9 ms. These are isolated fixture measurements, not production latency
or device navigation timings.

External ingress, deployed SSE, credentials, runner isolation and production
snapshot restoration require checks in their owning environments. See HANDOFF.md.

## Telemetry verification

After `pnpm build`, run `pnpm test:browser:telemetry`. Install Playwright's Chromium
once with `pnpm exec playwright install chromium`, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium` to use an installed Chromium.
The executable runner also exports `verifyTelemetry(page, baseUrl, requests)` in
the style of the other browser verifiers. It starts two isolated production builds
with scheduled work disabled and new temporary databases, plus one loopback HTTP
stub for Umami and GlitchTip. It does not inherit integration credentials or call
AI providers. Its enabled app explicitly allows `127.0.0.1` and sets the loopback-only
automation flag. Another context verifies bots are excluded without that flag.

`fixtures/umami-script.js` and `fixtures/umami-recorder.js` are unmodified public script
snapshots fetched from `https://umami.heerlab.com/{script,recorder}.js` on 2026-10-21.
The upstream Umami project is MIT-licensed; rrweb included in the recorder is MIT-licensed.
They are test fixtures, not assets shipped with the application. Refresh them deliberately
when upgrading Umami and recheck its supported attributes and privacy behavior. Tests
serve these files locally; no test fetches the real hosts. Analytics checks initial and
TanStack navigation pageviews, a Hunt Run now event, outbound host-only events, replay,
heatmaps, a scrubbed browser error envelope with the exact release/environment, and
zero telemetry requests without config. Pageviews and events scrub query strings
and title IDs. Replay Meta `href` and heatmap click/scroll `url` bypass `beforeSend`
and include the app route's path and query, including media search terms and title
IDs. The app's browser routes carry no secrets or credentials. The browser test
asserts that recorder URLs retain a synthetic search term and ID while pageviews
scrub them. Synthetic secret text and blocked DOM input/URL values must never appear
in the stub's received payloads. The stub matches the provisioned
strict masking and `[data-telemetry-block]` selector. Tests verify direct Umami-host
script loading and recording POSTs, initial and incremental blocked DOM regions,
and Settings blocking. The app has no recorder relay to scrub route URLs.

The same runner starts a built, instrumented Node process with `NODE_ENV=production`
and a dummy DSN pointing at the loopback stub. An unhandled `Promise.reject` must
produce an error envelope and exit with code 1.

Neither script writes cookies. The inspected analytics script only reads
`localStorage['umami.disabled']`, if an operator chooses to set it. Its session cache
and recorder/heatmap buffers live in memory. The configured Sentry SDK uses neither
cookies nor local/session storage; browser-session tracking is excluded. The browser
test asserts empty storage and zero cookies for a fresh context. The application's
existing `ba.sidebar` localStorage preference can appear after a user toggles the sidebar;
it is unrelated to telemetry. No new application storage keys are introduced.

`node --test scripts/glitchtip-upload-proxy.test.mjs`, also part of `pnpm test`,
starts only a loopback fake upstream and proxy. It checks chunk URL rewriting,
authorization override even when sentry-cli omits auth, and binary upload forwarding.
Real upload probes are manual and use the same script as CI:

```sh
infisical run --profile heerlab --env=prod --path=/ci -- \
  env SENTRY_RELEASE=beasty-arr@0.0.0-upload-probe bash scripts/upload-sourcemaps.sh dist/sourcemaps
```

Inspect the release and artifact listing through the proxy, then delete the probe.
Never print the injected token. Automated tests never contact live GlitchTip.

Unit tests use fake Sentry transport and stubbed fetch behind the network-denying
test setup. They cover disabled config and public config responses, scrubbing of
headers/queries/userinfo/emails/bearer/environment keys/webhook tokens,
loader attributes and the explicit domain gate, property filtering, outbound links, startup
error buffering, Fastify route errors and tagged scheduler failures. Container smoke
checks also reject every runtime `.map` file and check both existing-asset and missing
`/assets/*.map` requests return 404.

Custom events are emitted after successful API responses by `src/web/lib/api.ts`
through `trackMutation` in `src/web/lib/telemetry.ts`, including mutation hooks in
`src/web/lib/queries.ts`. No request body is copied into an event.

- `hunt_action`: `action` is `cycle`, `pause`, or `resume`, from the Hunt controls.
- `dry_run_changed`: `enabled`, from the dry-run confirmation control.
- `settings_saved`: `section` is `app` or `budget`, from Settings or budget saves.
- `fixer_action`: `action` is `analyze`, `apply`, `remove`, `ignore`, `cancel`,
  `run_all`, or `cancel_all`; `service` is included when the route names Sonarr/Radarr.
- `fixer_automation_changed`: `autoRun` / `autoApply` for the toggles present in a save.
- `oracle_recheck`: no properties, from explicit recheck/invalidate-and-recheck actions.
- `missing_search`: number of requested episodes in `count`, from Missing searches.
- `item_action`: `action`, `service`, `kind`, from item force/pause/resume/override actions.
- `api_failure`: route template, numeric `status` and HTTP `method`, from the API wrapper.
- `query_retry`: route template in `route`, from the shared QueryError Retry button.
- `outbound_link`: `host` only, from document link clicks including Arr links.
