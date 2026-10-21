import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { ApiError } from "./lib/api.js";
import { wireSseToQueryClient } from "./lib/queries.js";
import { captureBrowserError, startTelemetry } from "./lib/telemetry.js";
import { router } from "./router.js";
import "./styles.css";

void startTelemetry({
  allowAutomation:
    window.__BEASTY_TELEMETRY_TEST__ === true &&
    ["localhost", "127.0.0.1"].includes(location.hostname),
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

wireSseToQueryClient(queryClient);

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root");

function reportRootError(error: unknown): void {
  captureBrowserError(error);
  // biome-ignore lint/suspicious/noConsole: Preserve React's error output even when telemetry is disabled.
  console.error(error);
}

createRoot(rootElement, {
  onUncaughtError: reportRootError,
  onCaughtError: reportRootError,
  onRecoverableError: reportRootError,
}).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: "#15171d",
            border: "1px solid #262a33",
            color: "#e6e8ee",
            borderRadius: "6px",
            fontSize: "13px",
          },
        }}
      />
    </QueryClientProvider>
  </StrictMode>,
);
