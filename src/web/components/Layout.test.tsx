// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppLayout } from "./Layout.js";
import { QueryError } from "./QueryError.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Outlet: () => (
    <QueryError query={{ isError: true, data: undefined, refetch: async () => undefined }} />
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("../lib/events.js", () => ({ sse: { connect: vi.fn() }, useSseStatus: () => "off" }));
vi.mock("../lib/queries.js", () => ({ useConfig: () => ({ data: undefined }) }));
vi.mock("./CommandPalette.js", () => ({ CommandPalette: () => null }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("__APP_VERSION__", "test");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps four full-page legal links in the layout when a query fails", () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AppLayout />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load data.");
  expect(
    [...container.querySelectorAll("footer a")].map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ]),
  ).toEqual([
    ["Legal notice", "/legal-notice"],
    ["Privacy", "/privacy"],
    ["Impressum", "/impressum"],
    ["Datenschutz", "/datenschutz"],
  ]);
});
