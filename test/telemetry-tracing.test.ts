import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("omits health and SSE transactions while tracing a normal Fastify request", async () => {
  // OTel instrumentation must start before Fastify loads, in a fresh process.
  const code = `
    import assert from 'node:assert/strict';
    import * as Sentry from '@sentry/node';
    import {ignoreIncomingRequest} from './src/server/telemetry/config.ts';
    const transactions = [];
    Sentry.init({
      dsn: 'http://public@errors.example/1',
      tracesSampleRate: 1,
      traceLifecycle: 'static',
      sendClientReports: false,
      defaultIntegrations: false,
      integrations: [
        Sentry.httpIntegration({
          ignoreIncomingRequests: ignoreIncomingRequest,
          // The HTTP client belongs to this test, not the application.
          ignoreOutgoingRequests: () => true,
        }),
        Sentry.nativeNodeFetchIntegration(),
        Sentry.fastifyIntegration(),
        Sentry.onUncaughtExceptionIntegration(),
        Sentry.onUnhandledRejectionIntegration({mode: 'strict'}),
        Sentry.linkedErrorsIntegration(),
        Sentry.dedupeIntegration(),
      ],
      tracePropagationTargets: [],
      transport: () => ({
        send: async ([, items]) => {
          for (const [header, event] of items) {
            if (header.type === 'transaction') transactions.push(event);
          }
          return {statusCode: 200};
        },
        flush: async () => true,
      }),
    });
    const {default: Fastify} = await import('fastify');
    const {get} = await import('node:http');
    const {registerHealthRoutes} = await import('./src/server/http/routes/health.ts');
    const {registerEventRoutes} = await import('./src/server/http/routes/events.ts');
    const {EventBus} = await import('./src/server/events/bus.ts');
    const app = Fastify();
    registerHealthRoutes(app);
    registerEventRoutes(app, {bus: new EventBus()});
    app.get('/control', async () => ({status: 'ok'}));
    await app.listen({host: '127.0.0.1', port: 0});
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const request = (path, sse = false) => new Promise((resolve, reject) => {
      const req = get(base + path, res => {
        assert.equal(res.statusCode, 200);
        res.on('error', reject);
        if (sse) {
          res.once('data', chunk => {
            assert.match(String(chunk), /: connected/);
            res.destroy();
          });
          res.once('close', resolve);
        } else {
          res.resume();
          res.once('end', resolve);
        }
      });
      req.on('error', reject);
    });
    try {
      await request('/api/health');
      await request('/api/health?probe=1');
      await request('/api/events', true);
      await request('/api/events?last=1', true);
      await Sentry.flush(1000);
      assert.equal(transactions.length, 0, JSON.stringify(transactions));
      await request('/control');
      await Sentry.flush(1000);
      assert.equal(transactions.length, 1, JSON.stringify(transactions));
      assert.equal(transactions[0].transaction, 'GET /control');
      process.stdout.write('health=0 sse=0 control=1');
    } finally {
      await app.close();
      await Sentry.close(1000);
    }
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    {
      env: { PATH: process.env.PATH, NODE_ENV: "test", BEASTY_ARR_FORBID_LIVE_AI: "1" },
      timeout: 8000,
    },
  );
  expect(stdout).toBe("health=0 sse=0 control=1");
}, 10_000);
