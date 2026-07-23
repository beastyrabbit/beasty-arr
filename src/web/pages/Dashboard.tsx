import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import type { AppEventEnvelope } from "../../shared/api-types.js";
import type { HuntState } from "../../shared/domain.js";
import { LedDot } from "../components/LedDot.js";
import { ProgressRing } from "../components/ProgressRing.js";
import { RibbonLegend, SegmentedBar } from "../components/SegmentedBar.js";
import { EmptyState, Panel, Skeleton, StaleBanner } from "../components/Shell.js";
import { Sparkline } from "../components/Sparkline.js";
import { useLatestEvent, useSseEvent } from "../lib/events.js";
import { fmtNum, fmtPct, fmtTime, relTime } from "../lib/format.js";
import { useBudget, useDashboardSummary, useStatsHistory, useWins } from "../lib/queries.js";
import { STATE_META } from "../lib/states.js";

type FeedEntry = { key: string; at: number; text: string; kind: "started" | "result" };

export function DashboardPage() {
  const navigate = useNavigate();
  const summary = useDashboardSummary();
  const wins = useWins(12);
  const budget = useBudget();
  const history = useStatsHistory(30);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const nowHunting = useLatestEvent("hunt.search.started");

  useSseEvent("hunt.search.started", (e: AppEventEnvelope<"hunt.search.started">) => {
    setFeed((f) =>
      [
        {
          key: `s${e.id}`,
          at: e.ts,
          text: `${e.payload.commandName} — ${e.payload.label}${e.payload.dryRun ? " (dry)" : ""}`,
          kind: "started" as const,
        },
        ...f,
      ].slice(0, 8),
    );
  });
  useSseEvent("hunt.search.result", (e: AppEventEnvelope<"hunt.search.result">) => {
    setFeed((f) =>
      [
        {
          key: `r${e.id}`,
          at: e.ts,
          text: `#${e.payload.attemptId} ${e.payload.status}${e.payload.result ? ` · ${e.payload.result}` : ""}`,
          kind: "result" as const,
        },
        ...f,
      ].slice(0, 8),
    );
  });

  const goLibrary = (state: HuntState) => {
    navigate({ to: "/library/series", search: { states: [state], page: 1 } });
  };

  const s = summary.data;
  const germanTrend = history.data?.points.map((p) => p.germanPct) ?? [];

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-3">
      <StaleBanner visible={summary.isError && s !== undefined} />

      {/* Germanization hero */}
      <Panel className="p-4">
        {s ? (
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-4">
              <ProgressRing value={s.germanPct} size={64} strokeWidth={4} />
              <div>
                <div className="microlabel">Germanized</div>
                <div className="font-mono text-4xl font-semibold tracking-tight text-ink">
                  {fmtPct(s.germanPct)}
                </div>
                <div className="mt-0.5 flex items-center gap-3 text-[11px] text-muted">
                  <span>
                    incl. AI-paused{" "}
                    <span className="font-mono text-ink">{fmtPct(s.germanPctWithAiDone)}</span>
                  </span>
                  <span>
                    Δ week{" "}
                    <span
                      className="font-mono"
                      style={{
                        color:
                          s.deltaWeekPct == null
                            ? undefined
                            : s.deltaWeekPct >= 0
                              ? STATE_META.german.color
                              : STATE_META.missing.color,
                      }}
                    >
                      {s.deltaWeekPct == null
                        ? "—"
                        : `${s.deltaWeekPct >= 0 ? "+" : ""}${s.deltaWeekPct.toFixed(1)} pt`}
                    </span>
                  </span>
                </div>
              </div>
            </div>
            <div className="min-w-[260px] flex-1">
              <SegmentedBar counts={s.counts.total} scale="hero" onSegmentClick={goLibrary} />
              <RibbonLegend counts={s.counts.total} onSelect={goLibrary} className="mt-2.5" />
            </div>
            <div className="hidden shrink-0 flex-col items-end gap-1 lg:flex">
              <span className="microlabel">30d trend</span>
              <Sparkline values={germanTrend} width={140} height={36} />
              <span className="font-mono text-[11px] text-muted">
                hunts today {fmtNum(s.huntsToday)}
              </span>
            </div>
          </div>
        ) : summary.isError ? (
          <EmptyState message="Could not load summary." />
        ) : (
          <div className="flex items-center gap-4">
            <Skeleton className="h-16 w-16 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* live hunt activity */}
        <Panel title="Hunt activity" className="lg:col-span-1">
          <div className="p-3">
            {nowHunting ? (
              <div className="flex items-center gap-2 rounded-[6px] border border-line bg-bg p-2">
                <LedDot state="live" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-ink">{nowHunting.payload.label}</div>
                  <div className="font-mono text-[10px] text-muted">
                    {nowHunting.payload.commandName} · {relTime(nowHunting.ts)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[12px] text-muted">
                <LedDot state="off" /> Idle — next tick {relTime(s?.engine.nextTickAt ?? null)}
              </div>
            )}
            <ul className="mt-2 space-y-1">
              {feed.map((entry) => (
                <li key={entry.key} className="flex items-baseline gap-2 text-[11px]">
                  <span className="font-mono text-faint">{fmtTime(entry.at)}</span>
                  <span className={entry.kind === "started" ? "text-ink" : "text-muted"}>
                    {entry.text}
                  </span>
                </li>
              ))}
              {feed.length === 0 ? (
                <li className="text-[11px] text-faint">Waiting for live events…</li>
              ) : null}
            </ul>
          </div>
        </Panel>

        {/* recent wins ticker */}
        <Panel title="Recent wins" className="lg:col-span-1">
          <div className="p-3">
            {wins.data && wins.data.items.length > 0 ? (
              <ul className="space-y-1">
                {wins.data.items.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-baseline gap-2 border-l-2 py-0.5 pl-2"
                    style={{ borderColor: STATE_META.german.color }}
                  >
                    <span className="font-mono text-[10px] text-faint">{relTime(w.at)}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{w.title}</span>
                    <span className="font-mono text-[10px] text-muted">{w.label}</span>
                  </li>
                ))}
              </ul>
            ) : wins.isPending ? (
              <div className="space-y-2">
                <Skeleton className="w-full" />
                <Skeleton className="w-2/3" />
              </div>
            ) : (
              <EmptyState message="No wins yet. The hunt is on." />
            )}
          </div>
        </Panel>

        {/* fixer + AI summary */}
        <div className="flex flex-col gap-3">
          <Panel
            title="Fixer"
            actions={
              <button
                type="button"
                onClick={() => navigate({ to: "/fixer" })}
                className="cursor-pointer text-muted hover:text-ink"
                title="Open fixer"
              >
                <ArrowRight size={13} />
              </button>
            }
          >
            <div className="grid grid-cols-4 gap-2 p-3 text-center">
              {(
                [
                  ["stuck", s?.fixer.pending],
                  ["analyzing", s?.fixer.analyzing],
                  ["proposals", s?.fixer.proposals],
                  ["errors", s?.fixer.errors],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <div className="font-mono text-xl text-ink">{value ?? "—"}</div>
                  <div className="microlabel">{label}</div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Dub oracle">
            <div className="p-3">
              <div className="flex items-center gap-2 text-[12px]">
                <LedDot
                  state={
                    s?.ai.status === "configured"
                      ? "live"
                      : s?.ai.status === "off"
                        ? "off"
                        : s?.ai.status === "error"
                          ? "down"
                          : "reconnecting"
                  }
                />
                <span className="text-ink">{s?.ai.status ?? "—"}</span>
                <span className="ml-auto font-mono text-[11px] text-muted">
                  {s ? `${s.ai.checksToday}/${s.ai.capPerDay} today` : ""}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center">
                {s
                  ? (Object.entries(s.ai.verdictCounts) as [string, number][]).map(([v, n]) => (
                      <div key={v}>
                        <div className="font-mono text-[15px] text-ink">{n}</div>
                        <div className="microlabel">{v}</div>
                      </div>
                    ))
                  : null}
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* per-indexer budget bars */}
      <Panel
        title="Indexer budgets"
        actions={
          <button
            type="button"
            onClick={() => navigate({ to: "/activity/budget" })}
            className="cursor-pointer text-muted hover:text-ink"
            title="Budget ledger"
          >
            <ArrowRight size={13} />
          </button>
        }
      >
        <div className="space-y-2.5 p-3">
          {budget.data ? (
            budget.data.indexers.length > 0 ? (
              budget.data.indexers.map((ix) => <BudgetBar key={ix.id} ix={ix} />)
            ) : (
              <EmptyState message="No indexers synced from Prowlarr yet." />
            )
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
        </div>
      </Panel>
    </div>
  );
}

function BudgetBar({
  ix,
}: {
  ix: {
    id: number;
    name: string;
    cap: number | null;
    trailing24h: number;
    huntShare: number;
    organicShare: number;
    target: number | null;
    huntRatePerHour: number | null;
    inBackoff: boolean;
    excluded: boolean;
    canHuntNow: boolean;
  };
}) {
  const cap = ix.cap;
  const denom = cap ?? Math.max(ix.trailing24h, 1);
  const huntPct = Math.min(100, (ix.huntShare / denom) * 100);
  const organicPct = Math.min(100 - huntPct, (ix.organicShare / denom) * 100);
  const targetPct =
    cap !== null && ix.target !== null ? Math.min(100, (ix.target / cap) * 100) : null;

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2 text-[12px]">
        <span className="text-ink">{ix.name}</span>
        {ix.inBackoff ? <span className="microlabel text-missing">backoff</span> : null}
        {ix.excluded ? <span className="microlabel">excluded</span> : null}
        {!ix.canHuntNow && !ix.inBackoff ? (
          <span className="microlabel text-nongerman">throttled</span>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted">
          {ix.trailing24h}
          {cap !== null ? ` / ${cap}` : " · unlimited"}
          {ix.huntRatePerHour !== null ? ` · ${ix.huntRatePerHour.toFixed(1)}/h` : ""}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-[3px] bg-raised">
        <div
          className="absolute inset-y-0 left-0 bg-accent"
          style={{ width: `${huntPct}%` }}
          title="hunt"
        />
        <div
          className="absolute inset-y-0 bg-userpaused/70"
          style={{ left: `${huntPct}%`, width: `${organicPct}%` }}
          title="organic"
        />
        {targetPct !== null ? (
          <div
            className="absolute inset-y-0 w-px bg-ink"
            style={{ left: `${targetPct}%` }}
            title={`target ${ix.target?.toFixed(0)}`}
          />
        ) : null}
      </div>
    </div>
  );
}
