import { useNavigate } from "@tanstack/react-router";
import { Check, Loader2, X } from "lucide-react";
import { useState } from "react";
import type {
  AppSettingsDto,
  ConnectionKind,
  TestConnectionResponse,
} from "../../shared/api-types.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { EmptyState, Panel, Skeleton } from "../components/Shell.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent } from "../components/ui/dialog.js";
import { Field, Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { fmtDateTime, relTime } from "../lib/format.js";
import {
  useAiModels,
  useAiStatus,
  useBudget,
  useCodexLoginStart,
  useCodexLoginStatus,
  useConfig,
  useSetDryRun,
  useSystemAction,
  useTestConnection,
  useUpdateConfig,
} from "../lib/queries.js";
import { cn } from "../lib/utils.js";

export type SettingsTab = "connections" | "hunt" | "ai" | "danger";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "connections", label: "Connections" },
  { id: "hunt", label: "Hunt" },
  { id: "ai", label: "AI" },
  { id: "danger", label: "Danger zone" },
];

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  const navigate = useNavigate();
  const config = useConfig();

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3">
      <div className="flex items-center border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => navigate({ to: `/settings/${t.id}` })}
            className={cn(
              "-mb-px cursor-pointer border-b px-3 py-1.5 text-[12px] font-medium",
              tab === t.id
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink",
              t.id === "danger" && tab !== "danger" && "text-missing/70 hover:text-missing",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {config.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : !config.data ? (
        <EmptyState message="Could not load settings." />
      ) : tab === "connections" ? (
        <ConnectionsTab connections={config.data.connections} version={config.data.version} />
      ) : tab === "hunt" ? (
        <HuntTab settings={config.data.settings} />
      ) : tab === "ai" ? (
        <AiTab settings={config.data.settings} />
      ) : (
        <DangerTab settings={config.data.settings} />
      )}
    </div>
  );
}

// ============ connections ============

function ConnectionsTab({
  connections,
  version,
}: {
  connections: Record<
    ConnectionKind,
    { url: string | null; keyPresent: boolean; lastSyncAt: number | null }
  >;
  version: string;
}) {
  const test = useTestConnection();
  const resync = useSystemAction();
  const [results, setResults] = useState<Partial<Record<ConnectionKind, TestConnectionResponse>>>(
    {},
  );

  return (
    <div className="flex flex-col gap-3">
      {(Object.keys(connections) as ConnectionKind[]).map((service) => {
        const conn = connections[service];
        const result = results[service];
        return (
          <Panel key={service} title={service}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3">
              <div>
                <div className="microlabel">URL</div>
                <div className="font-mono text-[12px] text-ink">{conn.url ?? "not set (env)"}</div>
              </div>
              <div>
                <div className="microlabel">API key</div>
                <div
                  className={cn(
                    "font-mono text-[12px]",
                    conn.keyPresent ? "text-german" : "text-missing",
                  )}
                >
                  {conn.keyPresent ? "configured · write-only" : "missing"}
                </div>
              </div>
              <div>
                <div className="microlabel">Last sync</div>
                <div className="font-mono text-[12px] text-muted">{relTime(conn.lastSyncAt)}</div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {result ? (
                  <span
                    className={cn(
                      "flex items-center gap-1 text-[12px]",
                      result.ok ? "text-german" : "text-missing",
                    )}
                  >
                    {result.ok ? <Check size={12} /> : <X size={12} />}
                    {result.message}
                    {result.version ? (
                      <span className="font-mono text-faint">v{result.version}</span>
                    ) : null}
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={test.isPending}
                  onClick={() =>
                    test.mutate(
                      { service },
                      { onSuccess: (r) => setResults((prev) => ({ ...prev, [service]: r })) },
                    )
                  }
                >
                  Test
                </Button>
              </div>
            </div>
          </Panel>
        );
      })}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          onClick={() => resync.mutate("resync")}
          disabled={resync.isPending}
        >
          Sync now (full reconcile)
        </Button>
        <span className="ml-auto font-mono text-[11px] text-faint">beasty-arr v{version}</span>
      </div>
    </div>
  );
}

// ============ hunt + budget ============

function HuntTab({ settings }: { settings: AppSettingsDto }) {
  const update = useUpdateConfig();
  const budget = useBudget();
  const [form, setForm] = useState({
    huntTickMinutes: settings.huntTickMinutes,
    maxCommandsPerCycle: settings.maxCommandsPerCycle,
    queueGateThreshold: settings.queueGateThreshold,
    missingToUpgradeRatio: settings.missingToUpgradeRatio,
    dubLagDaysDefault: settings.dubLagDaysDefault,
    huntSpecials: settings.huntSpecials,
    budgetSafetyPct: settings.budgetSafetyPct,
    budgetHorizonHours: settings.budgetHorizonHours,
    budgetTrickleMinPerHour: settings.budgetTrickleMinPerHour,
    budgetPacingHorizonHours: settings.budgetPacingHorizonHours,
    budgetBurstMaxDivisor: settings.budgetBurstMaxDivisor,
  });

  const num =
    (key: keyof typeof form, float = false) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = float ? Number.parseFloat(e.target.value) : Number.parseInt(e.target.value, 10);
      setForm((f) => ({ ...f, [key]: Number.isNaN(v) ? 0 : v }));
    };

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Hunt engine">
        <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-3">
          <Field label="Tick (minutes)">
            <Input
              type="number"
              value={form.huntTickMinutes}
              onChange={num("huntTickMinutes")}
              className="font-mono"
            />
          </Field>
          <Field label="Max commands / cycle" hint="hard safety valve">
            <Input
              type="number"
              value={form.maxCommandsPerCycle}
              onChange={num("maxCommandsPerCycle")}
              className="font-mono"
            />
          </Field>
          <Field label="Queue gate" hint="skip cycle when arr queue exceeds">
            <Input
              type="number"
              value={form.queueGateThreshold}
              onChange={num("queueGateThreshold")}
              className="font-mono"
            />
          </Field>
          <Field label="Missing : upgrade ratio">
            <Input
              value={form.missingToUpgradeRatio}
              onChange={(e) => setForm((f) => ({ ...f, missingToUpgradeRatio: e.target.value }))}
              className="font-mono"
            />
          </Field>
          <Field label="Dub lag (days)" hint="wait after non-German import">
            <Input
              type="number"
              value={form.dubLagDaysDefault}
              onChange={num("dubLagDaysDefault")}
              className="font-mono"
            />
          </Field>
          <span className="flex items-center gap-2 self-end pb-1.5 text-[12px] text-muted">
            <Switch
              checked={form.huntSpecials}
              onCheckedChange={(v) => setForm((f) => ({ ...f, huntSpecials: v }))}
            />
            Hunt specials (S00)
          </span>
        </div>
      </Panel>

      <Panel title="Budget controller">
        <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-3">
          <Field label="Safety %" hint="forecast-error buffer (0–0.9)">
            <Input
              type="number"
              step="0.01"
              value={form.budgetSafetyPct}
              onChange={num("budgetSafetyPct", true)}
              className="font-mono"
            />
          </Field>
          <Field label="Forecast horizon (h)">
            <Input
              type="number"
              value={form.budgetHorizonHours}
              onChange={num("budgetHorizonHours")}
              className="font-mono"
            />
          </Field>
          <Field label="Trickle min (queries/h)">
            <Input
              type="number"
              step="0.5"
              value={form.budgetTrickleMinPerHour}
              onChange={num("budgetTrickleMinPerHour", true)}
              className="font-mono"
            />
          </Field>
          <Field label="Pacing horizon (h)">
            <Input
              type="number"
              value={form.budgetPacingHorizonHours}
              onChange={num("budgetPacingHorizonHours")}
              className="font-mono"
            />
          </Field>
          <Field label="Burst divisor" hint="burstMax = cap / divisor">
            <Input
              type="number"
              value={form.budgetBurstMaxDivisor}
              onChange={num("budgetBurstMaxDivisor")}
              className="font-mono"
            />
          </Field>
        </div>

        {/* live preview vs current indexer data */}
        <div className="border-t border-line p-3">
          <div className="microlabel mb-2">Live preview (current usage, these knobs)</div>
          {budget.data && budget.data.indexers.length > 0 ? (
            <div className="space-y-2">
              {budget.data.indexers
                .filter((ix) => ix.cap !== null)
                .map((ix) => {
                  const cap = ix.cap ?? 0;
                  const target = Math.max(
                    0,
                    cap * (1 - form.budgetSafetyPct) - ix.forecastNextHorizon,
                  );
                  const surplus = target - ix.trailing24h;
                  const rate = Math.min(
                    Math.max(
                      surplus / Math.max(1, form.budgetPacingHorizonHours),
                      form.budgetTrickleMinPerHour,
                    ),
                    cap / Math.max(1, form.budgetBurstMaxDivisor),
                  );
                  const usedPct = Math.min(100, (ix.trailing24h / cap) * 100);
                  const targetPct = Math.min(100, (target / cap) * 100);
                  return (
                    <div key={ix.id}>
                      <div className="flex items-baseline justify-between text-[11px]">
                        <span className="text-ink">{ix.name}</span>
                        <span className="font-mono text-muted">
                          target {target.toFixed(0)}/{cap} · rate {rate.toFixed(1)}/h
                        </span>
                      </div>
                      <div className="relative mt-0.5 h-1.5 overflow-hidden rounded-[3px] bg-raised">
                        <div
                          className="absolute inset-y-0 left-0 bg-accent/70"
                          style={{ width: `${usedPct}%` }}
                        />
                        <div
                          className="absolute inset-y-0 w-px bg-ink"
                          style={{ left: `${targetPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          ) : (
            <p className="text-[12px] text-faint">No limited indexers to preview.</p>
          )}
        </div>
      </Panel>

      <div>
        <Button variant="primary" disabled={update.isPending} onClick={() => update.mutate(form)}>
          Save hunt & budget settings
        </Button>
      </div>
    </div>
  );
}

// ============ ai ============

function AiTab({ settings }: { settings: AppSettingsDto }) {
  const update = useUpdateConfig();
  const aiStatus = useAiStatus();
  const models = useAiModels();
  const [form, setForm] = useState({
    aiProvider: settings.aiProvider,
    aiModel: settings.aiModel,
    aiMaxChecksPerDay: settings.aiMaxChecksPerDay,
    aiPauseConfidence: settings.aiPauseConfidence,
    aiMinSearchesBeforeCheck: settings.aiMinSearchesBeforeCheck,
    aiMinAgeMonths: settings.aiMinAgeMonths,
  });
  const [loginOpen, setLoginOpen] = useState(false);

  const modelOptions = models.data?.options.map((o) => ({ value: o.model, label: o.label })) ?? [
    { value: form.aiModel, label: form.aiModel },
  ];

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Dub oracle">
        <div className="grid grid-cols-2 gap-3 p-3 md:grid-cols-3">
          <Field label="Provider">
            <Select
              value={form.aiProvider}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, aiProvider: v as typeof f.aiProvider }))
              }
              options={[
                { value: "codex", label: "Codex (gpt-5.5)" },
                { value: "aibox", label: "AI box (Ollama)" },
                { value: "off", label: "Off" },
              ]}
            />
          </Field>
          <Field label="Model">
            <Select
              value={form.aiModel}
              onValueChange={(v) => setForm((f) => ({ ...f, aiModel: v }))}
              options={modelOptions}
            />
          </Field>
          <Field label="Checks / day">
            <Input
              type="number"
              value={form.aiMaxChecksPerDay}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  aiMaxChecksPerDay: Number.parseInt(e.target.value, 10) || 0,
                }))
              }
              className="font-mono"
            />
          </Field>
          <Field label="Pause confidence" hint="min confidence to ai-pause">
            <Input
              type="number"
              step="0.05"
              value={form.aiPauseConfidence}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  aiPauseConfidence: Number.parseFloat(e.target.value) || 0,
                }))
              }
              className="font-mono"
            />
          </Field>
          <Field label="Min searches first">
            <Input
              type="number"
              value={form.aiMinSearchesBeforeCheck}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  aiMinSearchesBeforeCheck: Number.parseInt(e.target.value, 10) || 0,
                }))
              }
              className="font-mono"
            />
          </Field>
          <Field label="Min age (months)">
            <Input
              type="number"
              value={form.aiMinAgeMonths}
              onChange={(e) =>
                setForm((f) => ({ ...f, aiMinAgeMonths: Number.parseInt(e.target.value, 10) || 0 }))
              }
              className="font-mono"
            />
          </Field>
        </div>
        <div className="flex items-center gap-3 border-t border-line p-3">
          <span className="text-[12px] text-muted">
            Status:{" "}
            <span
              className={cn(
                "font-mono",
                aiStatus.data?.status === "configured"
                  ? "text-german"
                  : aiStatus.data?.status === "error"
                    ? "text-missing"
                    : "text-nongerman",
              )}
            >
              {aiStatus.data?.status ?? "…"}
            </span>
            {aiStatus.data?.detail ? (
              <span className="ml-2 text-faint">{aiStatus.data.detail}</span>
            ) : null}
          </span>
          <Button variant="outline" size="sm" onClick={() => setLoginOpen(true)}>
            Codex device login
          </Button>
          <span className="ml-auto font-mono text-[11px] text-faint">
            {aiStatus.data
              ? `${aiStatus.data.checksToday}/${aiStatus.data.capPerDay} checks today`
              : ""}
          </span>
        </div>
      </Panel>
      <div>
        <Button variant="primary" disabled={update.isPending} onClick={() => update.mutate(form)}>
          Save AI settings
        </Button>
      </div>
      <CodexLoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
    </div>
  );
}

function CodexLoginDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const start = useCodexLoginStart();
  const [loginId, setLoginId] = useState<string | null>(null);
  const status = useCodexLoginStatus(open ? loginId : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Codex device login"
        description="Authenticates the pod's Pi/Codex OAuth. The token persists on the data volume."
      >
        {!loginId ? (
          <Button
            variant="primary"
            disabled={start.isPending}
            onClick={() => start.mutate(undefined, { onSuccess: (r) => setLoginId(r.id) })}
          >
            {start.isPending ? "Starting…" : "Start device login"}
          </Button>
        ) : status.data ? (
          <div className="flex flex-col gap-2">
            {status.data.verificationUri ? (
              <>
                <span className="microlabel">Open</span>
                <a
                  href={status.data.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[13px] text-accent underline underline-offset-2"
                >
                  {status.data.verificationUri}
                </a>
                <span className="microlabel mt-1">and enter code</span>
                <span className="font-mono text-2xl tracking-[0.2em] text-ink">
                  {status.data.userCode ?? "…"}
                </span>
              </>
            ) : null}
            <div className="mt-2 flex items-center gap-2 text-[12px]">
              {status.data.status === "authenticated" ? (
                <span className="flex items-center gap-1 text-german">
                  <Check size={13} /> Authenticated.
                </span>
              ) : status.data.status === "failed" || status.data.status === "expired" ? (
                <span className="text-missing">
                  {status.data.error ?? `Login ${status.data.status}.`}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-muted">
                  <Loader2 size={13} className="animate-spin" /> Waiting for confirmation…
                </span>
              )}
            </div>
          </div>
        ) : (
          <Loader2 size={16} className="animate-spin text-muted" />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============ danger ============

function DangerTab({ settings }: { settings: AppSettingsDto }) {
  const setDryRun = useSetDryRun();
  const system = useSystemAction();
  const [confirm, setConfirm] = useState<"live" | "reset" | "verdicts" | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <Panel className="border-missing/50" title="Dry-run master switch">
        <div className="flex items-center gap-3 p-3">
          <Switch
            checked={settings.dryRun}
            onCheckedChange={(v) => {
              if (v) setDryRun.mutate(true);
              else setConfirm("live");
            }}
          />
          <div>
            <div className="text-[13px] text-ink">
              Dry-run is <span className="font-mono">{settings.dryRun ? "ON" : "OFF"}</span>
            </div>
            <p className="text-[12px] text-muted">
              While on, nothing is sent to Sonarr/Radarr/Prowlarr and no AI calls are made — actions
              are simulated and logged.
            </p>
          </div>
        </div>
      </Panel>

      <Panel className="border-missing/50" title="Destructive maintenance">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-muted">
              Full resync — rebuild the mirror from the arrs (paced, safe).
            </p>
            <Button variant="outline" size="sm" onClick={() => system.mutate("resync")}>
              Full resync
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-muted">
              Reset hunt state — zero all tiers, counters, and eligibility timers.
            </p>
            <Button variant="danger" size="sm" onClick={() => setConfirm("reset")}>
              Reset hunt state
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-muted">
              Clear AI verdicts — supersede every verdict; paused items wake up.
            </p>
            <Button variant="danger" size="sm" onClick={() => setConfirm("verdicts")}>
              Clear AI verdicts
            </Button>
          </div>
        </div>
      </Panel>

      <ConfirmDialog
        open={confirm === "live"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Go live"
        description="Turning dry-run OFF lets beasty-arr send real search commands, imports, and removals to your arrs."
        confirmLabel="Go live"
        danger
        confirmPhrase="live"
        busy={setDryRun.isPending}
        onConfirm={() => {
          setDryRun.mutate(false);
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Reset hunt state"
        description="All backoff tiers, search counters, and eligibility timers are zeroed. The hunt starts over."
        confirmLabel="Reset hunt state"
        danger
        confirmPhrase="reset"
        onConfirm={() => {
          system.mutate("reset-hunt-state");
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "verdicts"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Clear AI verdicts"
        description="Every verdict is superseded and AI-paused items resume hunting. Checks will re-run over time (budgeted)."
        confirmLabel="Clear verdicts"
        danger
        onConfirm={() => {
          system.mutate("clear-verdicts");
          setConfirm(null);
        }}
      />
      <p className="font-mono text-[10px] text-faint">last config load {fmtDateTime(Date.now())}</p>
    </div>
  );
}
