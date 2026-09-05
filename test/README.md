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

`browser-review.mjs` exports `verifyReviewFlows(page, baseUrl, evidenceDir)` for a
Playwright Page. Serve the production build from an isolated application with
`registerJobs: false`, no integration environment and a new temporary data
directory. The verifier installs synthetic queue, analysis, apply and Missing
responses and a fake EventSource. It checks keyboard review, cached proposal
selection isolation, the exact apply request, error versus empty states, Retry,
and a stale-cache refresh after SSE reconnect. Its screenshots contain fixture
data only. Use a context with video recording to capture the interaction.

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
