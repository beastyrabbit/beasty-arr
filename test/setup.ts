import http from "node:http";
import https from "node:https";
import net from "node:net";
import { beforeEach, vi } from "vitest";

process.env.BEASTY_ARR_FORBID_LIVE_AI = "1";
process.env.NODE_ENV = "test";

function unexpectedNetwork(): never {
  throw new Error("Unexpected network access in test; inject a fake transport.");
}

function installNetworkGuard() {
  vi.spyOn(globalThis, "fetch").mockImplementation(unexpectedNetwork);
  vi.spyOn(http, "request").mockImplementation(unexpectedNetwork);
  vi.spyOn(http, "get").mockImplementation(unexpectedNetwork);
  vi.spyOn(https, "request").mockImplementation(unexpectedNetwork);
  vi.spyOn(https, "get").mockImplementation(unexpectedNetwork);
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(unexpectedNetwork);
}
installNetworkGuard();
beforeEach(installNetworkGuard);
