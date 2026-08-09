import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, Gauge, Sparkles, TriangleAlert } from "lucide-react";
import type { IndexerBudget, StateCounts, WinItem } from "../../shared/api-types.js";
import type { ArrSource, HuntState } from "../../shared/domain.js";
import { EmptyState, Panel, Skeleton, StaleBanner } from "../components/Shell.js";
import { fmtNum, fmtPct, relTime } from "../lib/format.js";
import { useBudget, useDashboardSummary, useWins } from "../lib/queries.js";
import { STATE_META } from "../lib/states.js";

type Attribution = {
  hunt: number;
  sonarr: number;
  radarr: number;
  fixer: number;
  otherSources: Record<string, number>;
};

const ATTRIBUTION_COLORS = {
  hunt: "#f0a63a",
  sonarr: "#66a7c5",
  radarr: "#7eaa78",
  fixer: "#b78ad7",
};

const OTHER_SOURCE_COLORS = ["#d2a05f", "#6f7682", "#8f83bd", "#6ca69a", "#bd7f8d"];

type AttributionEntry = { key: string; label: string; value: number; color: string };

export function DashboardPage() {
  const navigate = useNavigate();
  const summary = useDashboardSummary();
  const wins = useWins(5);
  const budget = useBudget();
  const s = summary.data;
  const priorityOne = (budget.data?.indexers ?? []).filter(
    (indexer) => indexer.enabled && indexer.priority === 1,
  );
  const secondary = (budget.data?.indexers ?? []).filter(
    (indexer) => indexer.enabled && indexer.priority !== 1,
  );
  const attribution = aggregateAttribution(priorityOne);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-3">
      <StaleBanner visible={summary.isError && s !== undefined} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <LibrarySide
          source="sonarr"
          counts={s?.counts.sonarr}
          onOpen={(state) =>
            navigate({ to: "/library/series", search: { states: [state], page: 1 } })
          }
        />
        <LibrarySide
          source="radarr"
          counts={s?.counts.radarr}
          onOpen={(state) =>
            navigate({ to: "/library/movies", search: { states: [state], page: 1 } })
          }
        />
      </div>

      <Panel
        title="Priority 1 indexer limits"
        actions={
          <button
            type="button"
            onClick={() => navigate({ to: "/activity/budget" })}
            className="flex cursor-pointer items-center gap-1 text-[11px] text-muted hover:text-ink"
          >
            Full ledger <ArrowRight size={12} />
          </button>
        }
      >
        {budget.isPending ? (
          <div className="space-y-3 p-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : priorityOne.length > 0 ? (
          <div className="divide-y divide-line">
            {priorityOne.map((indexer) => (
              <IndexerLimitRow
                key={indexer.id}
                indexer={indexer}
                horizonHours={budget.data?.settings.budgetHorizonHours ?? 6}
              />
            ))}
          </div>
        ) : (
          <EmptyState message="No enabled priority 1 indexers." />
        )}
        {secondary.length > 0 ? (
          <div className="border-t border-line px-4 py-2 text-[10px] text-faint">
            {secondary.length} lower-priority enabled indexer{secondary.length === 1 ? "" : "s"}{" "}
            hidden · {fmtNum(secondary.reduce((sum, item) => sum + item.trailing24h, 0))} queries /
            24h combined
          </div>
        ) : null}
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1fr]">
        <Panel title="Who spent the priority 1 budget?">
          <div className="p-4">
            <AttributionBar attribution={attribution} />
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
              {attributionEntries(attribution).map((entry) => (
                <div key={entry.key} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: entry.color }} />
                  <div>
                    <div className="font-mono text-[12px] text-ink">{fmtNum(entry.value)}</div>
                    <div className="microlabel">{entry.label}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-4 text-faint">
              App names are measured from Prowlarr history. Hunt is Beasty-arr's dispatch
              attribution through Sonarr/Radarr; Fixer imports existing downloads and does not issue
              indexer searches.
            </p>
          </div>
        </Panel>

        <Panel title="Automation">
          <div className="grid grid-cols-2 gap-px bg-line">
            <div className="bg-surface p-4">
              <div className="flex items-center gap-1.5 text-[12px] text-ink">
                <Sparkles size={13} style={{ color: STATE_META.ai_paused.color }} /> Dub oracle
              </div>
              <div className="mt-2 font-mono text-xl text-ink">
                {s ? `${s.ai.checksToday}/${s.ai.capPerDay}` : "—"}
              </div>
              <div className="mt-0.5 text-[10px] text-muted">
                AI checks today · {s?.ai.status ?? "unknown"}
              </div>
            </div>
            <button
              type="button"
              className="cursor-pointer bg-surface p-4 text-left hover:bg-raised"
              onClick={() => navigate({ to: "/fixer" })}
            >
              <div className="text-[12px] text-ink">Fixer</div>
              <div className="mt-2 font-mono text-xl text-ink">{s?.fixer.pending ?? "—"}</div>
              <div className="mt-0.5 text-[10px] text-muted">
                waiting · {s?.fixer.analyzing ?? "—"} analyzing · {s?.fixer.errors ?? "—"} errors
              </div>
            </button>
          </div>
        </Panel>
      </div>

      <Panel title="Last five German wins">
        {wins.isPending ? (
          <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-5">
            {["win-a", "win-b", "win-c", "win-d", "win-e"].map((key) => (
              <Skeleton key={key} className="h-36 w-full" />
            ))}
          </div>
        ) : wins.data?.items.length ? (
          <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-5">
            {wins.data.items.map((win) => (
              <WinTile key={win.id} win={win} />
            ))}
          </div>
        ) : (
          <EmptyState message="No German wins recorded yet." />
        )}
      </Panel>
    </div>
  );
}

function LibrarySide({
  source,
  counts,
  onOpen,
}: {
  source: ArrSource;
  counts?: StateCounts;
  onOpen: (state: HuntState) => void;
}) {
  const considered = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0) -
      counts.unreleased -
      counts.ai_paused -
      counts.unmonitored -
      counts.ignored
    : 0;
  const germanPct = counts && considered > 0 ? (counts.german / considered) * 100 : 0;
  const sourceColor = source === "sonarr" ? ATTRIBUTION_COLORS.sonarr : ATTRIBUTION_COLORS.radarr;
  const states: HuntState[] = ["german", "non_german", "missing", "ai_paused"];

  return (
    <Panel className="overflow-hidden">
      <div className="border-l-[3px] p-4" style={{ borderColor: sourceColor }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-semibold text-ink">
              {source === "sonarr" ? "Sonarr · series" : "Radarr · movies"}
            </h2>
            <p className="mt-0.5 text-[10px] text-muted">German coverage for huntable items</p>
          </div>
          <div className="font-mono text-2xl font-semibold text-ink">
            {counts ? fmtPct(germanPct) : "—"}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 divide-x divide-line border-y border-line">
          {states.map((state) => (
            <button
              key={state}
              type="button"
              className="cursor-pointer px-2 py-2.5 text-left hover:bg-raised"
              onClick={() => onOpen(state)}
            >
              <div className="font-mono text-[15px]" style={{ color: STATE_META[state].color }}>
                {counts?.[state] ?? "—"}
              </div>
              <div className="microlabel mt-0.5">{STATE_META[state].label}</div>
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function IndexerLimitRow({
  indexer,
  horizonHours,
}: {
  indexer: IndexerBudget;
  horizonHours: number;
}) {
  const cap = indexer.cap;
  const remaining = cap == null ? null : Math.max(0, cap - indexer.trailing24h);
  const forecastHunt = (indexer.huntRatePerHour ?? 0) * horizonHours;
  const projectedSpend = indexer.forecastNextHorizon + forecastHunt;
  const projectedTotal = indexer.trailing24h + projectedSpend;
  const burnPerHour = horizonHours > 0 ? projectedSpend / horizonHours : 0;
  const hoursToCap = remaining != null && burnPerHour > 0 ? remaining / burnPerHour : null;
  const willHit = cap != null && projectedTotal >= cap;
  const queryPct = cap ? Math.min(100, (indexer.trailing24h / cap) * 100) : 0;
  const grabPct = indexer.grabLimit
    ? Math.min(100, (indexer.trailing24hGrabs / indexer.grabLimit) * 100)
    : 0;
  const attribution = attributionFor(indexer);

  return (
    <div className="px-4 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 lg:w-52">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{indexer.name}</span>
            <span className="microlabel">P1</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[10px]">
            {willHit ? (
              <TriangleAlert size={12} className="text-missing" />
            ) : (
              <Check size={12} className="text-german" />
            )}
            <span className={willHit ? "text-missing" : "text-muted"}>
              {cap == null
                ? "No query limit"
                : willHit && hoursToCap != null
                  ? `Projected limit in ~${formatHours(hoursToCap)}`
                  : `Safe for the next ${horizonHours}h forecast`}
            </span>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[10px] text-muted">
            <span>Queries</span>
            <span className="ml-auto font-mono text-ink">
              {fmtNum(indexer.trailing24h)} / {cap == null ? "∞" : fmtNum(cap)}
            </span>
            {remaining != null ? <span className="font-mono">{fmtNum(remaining)} left</span> : null}
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-[3px] bg-raised">
            <div className="h-full bg-accent" style={{ width: `${queryPct}%` }} />
          </div>
          <div className="mt-1.5 flex gap-3 font-mono text-[9px] text-faint">
            <span>
              +{fmtNum(Math.round(projectedSpend))} forecast / {horizonHours}h
            </span>
            {indexer.target != null ? (
              <span>safe target {fmtNum(Math.round(indexer.target))}</span>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[10px] text-muted">
            <span>Grabs</span>
            <span className="ml-auto font-mono text-ink">
              {fmtNum(indexer.trailing24hGrabs)} /{" "}
              {indexer.grabLimit == null ? "∞" : fmtNum(indexer.grabLimit)}
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-[3px] bg-raised">
            <div className="h-full bg-userpaused" style={{ width: `${grabPct}%` }} />
          </div>
          <div className="mt-1.5">
            <AttributionBar attribution={attribution} compact />
          </div>
        </div>
      </div>
    </div>
  );
}

function attributionFor(indexer: IndexerBudget): Attribution {
  const observed = indexer.attribution;
  const hunt = Math.min(indexer.huntShare, indexer.trailing24h);
  const sonarrBase = Math.max(0, observed.observedSonarr - observed.huntSonarr);
  const radarrBase = Math.max(0, observed.observedRadarr - observed.huntRadarr);
  const namedOther = { ...observed.observedOtherSources };
  const namedOtherTotal = Object.values(namedOther).reduce((sum, value) => sum + value, 0);
  if (namedOtherTotal < observed.observedOther) {
    namedOther["Other apps"] = observed.observedOther - namedOtherTotal;
  }
  const otherBase = Object.values(namedOther).reduce((sum, value) => sum + value, 0);
  const baseTotal = sonarrBase + radarrBase + otherBase;
  const organic = Math.max(0, indexer.trailing24h - hunt);
  if (baseTotal <= 0) {
    return {
      hunt,
      sonarr: 0,
      radarr: 0,
      fixer: 0,
      otherSources: organic > 0 ? { "Other apps": organic } : {},
    };
  }
  const weighted = [
    { key: "sonarr", weight: sonarrBase },
    { key: "radarr", weight: radarrBase },
    ...Object.entries(namedOther).map(([source, weight]) => ({ key: `source:${source}`, weight })),
  ].map((entry) => {
    const exact = (organic * entry.weight) / baseTotal;
    return { ...entry, value: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remainder = organic - weighted.reduce((sum, entry) => sum + entry.value, 0);
  for (const entry of [...weighted].sort((a, b) => b.fraction - a.fraction)) {
    if (remainder <= 0) break;
    entry.value += 1;
    remainder -= 1;
  }
  const sonarr = weighted.find((entry) => entry.key === "sonarr")?.value ?? 0;
  const radarr = weighted.find((entry) => entry.key === "radarr")?.value ?? 0;
  const otherSources = Object.fromEntries(
    weighted
      .filter((entry) => entry.key.startsWith("source:"))
      .map((entry) => [entry.key.slice("source:".length), entry.value]),
  );
  return {
    hunt,
    sonarr,
    radarr,
    fixer: 0,
    otherSources,
  };
}

function aggregateAttribution(indexers: IndexerBudget[]): Attribution {
  return indexers.reduce<Attribution>(
    (total, indexer) => {
      const value = attributionFor(indexer);
      total.hunt += value.hunt;
      total.sonarr += value.sonarr;
      total.radarr += value.radarr;
      total.fixer += value.fixer;
      for (const [source, queries] of Object.entries(value.otherSources)) {
        total.otherSources[source] = (total.otherSources[source] ?? 0) + queries;
      }
      return total;
    },
    { hunt: 0, sonarr: 0, radarr: 0, fixer: 0, otherSources: {} },
  );
}

function attributionEntries(attribution: Attribution): AttributionEntry[] {
  const fixed: AttributionEntry[] = [
    { key: "hunt", label: "Hunt", value: attribution.hunt, color: ATTRIBUTION_COLORS.hunt },
    {
      key: "sonarr",
      label: "Sonarr itself",
      value: attribution.sonarr,
      color: ATTRIBUTION_COLORS.sonarr,
    },
    {
      key: "radarr",
      label: "Radarr itself",
      value: attribution.radarr,
      color: ATTRIBUTION_COLORS.radarr,
    },
    { key: "fixer", label: "Fixer", value: attribution.fixer, color: ATTRIBUTION_COLORS.fixer },
  ];
  const sources = Object.entries(attribution.otherSources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, value], index) => ({
      key: `source:${source}`,
      label: source,
      value,
      color: OTHER_SOURCE_COLORS[index % OTHER_SOURCE_COLORS.length] ?? "#6f7682",
    }));
  return [...fixed, ...sources];
}

function AttributionBar({
  attribution,
  compact = false,
}: {
  attribution: Attribution;
  compact?: boolean;
}) {
  const entries = attributionEntries(attribution);
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <div className={`flex overflow-hidden rounded-[3px] bg-raised ${compact ? "h-1.5" : "h-3"}`}>
      {entries.map((entry) =>
        entry.value > 0 ? (
          <div
            key={entry.key}
            style={{
              width: `${total > 0 ? (entry.value / total) * 100 : 0}%`,
              background: entry.color,
            }}
            title={`${entry.label}: ${entry.value}`}
          />
        ) : null,
      )}
    </div>
  );
}

function WinTile({ win }: { win: WinItem }) {
  return (
    <article className="flex min-w-0 gap-3 bg-surface p-3 lg:flex-col">
      <div className="h-20 w-14 shrink-0 overflow-hidden rounded-[4px] bg-raised lg:h-32 lg:w-full">
        {win.posterUrl ? (
          <img src={win.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-faint">
            <Gauge size={18} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium leading-4 text-ink">{win.reason}</div>
        <div className="mt-1 truncate text-[10px] text-muted">{win.title}</div>
        <div className="mt-1 font-mono text-[9px] text-faint">
          {win.source} · {win.quality ?? "quality unknown"} · {relTime(win.at)}
        </div>
      </div>
    </article>
  );
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
