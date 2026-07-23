import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { ApiError } from "../lib/api.js";
import { useLogin } from "../lib/queries.js";

export function LoginPage() {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const login = useLogin();
  const navigate = useNavigate();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    login.mutate(apiKey, {
      onSuccess: () => navigate({ to: "/" }),
      onError: (err) =>
        setError(err instanceof ApiError && err.status === 401 ? "Invalid key." : "Login failed."),
    });
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg">
      <form onSubmit={submit} className="w-[320px] rounded-[6px] border border-line bg-surface p-6">
        <h1 className="text-[15px] font-semibold tracking-tight text-ink">
          beasty<span className="text-accent">-arr</span>
        </h1>
        <p className="mt-1 text-[12px] text-muted">German-hunting companion. Enter the app key.</p>
        <label className="mt-5 block" htmlFor="login-api-key">
          <span className="microlabel">API key</span>
          <Input
            id="login-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
            autoComplete="current-password"
            className="mt-1 font-mono"
            placeholder="••••••••••••"
          />
        </label>
        {error ? <p className="mt-2 text-[12px] text-missing">{error}</p> : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="mt-4 w-full"
          disabled={apiKey.length === 0 || login.isPending}
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
