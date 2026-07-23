import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { ApiError, configureApi } from "./lib/api.js";
import { wireSseToQueryClient } from "./lib/queries.js";
import { router } from "./router.js";
import "./styles.css";

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

configureApi({
  onUnauthorized: () => {
    if (window.location.pathname !== "/login") {
      router.navigate({ to: "/login" });
    }
  },
});

wireSseToQueryClient(queryClient);

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing #root");

createRoot(rootElement).render(
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
