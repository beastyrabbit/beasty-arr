import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronRight,
  Clock3,
  Gauge,
  ListFilter,
  Pause,
  Play,
  Search,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  X,
  Zap,
} from "lucide-react";
import { useState } from "react";
import type {
  AiDormantItem,
  AppSettingsDto,
  HuntQueueItem,
  HuntStatusResponse,
  IndexerBudget,
  MovieDetail,
  PausedItem,
  SearchResult,
  SeriesDetail,
} from "../../shared/api-types.js";
import { EmptyState, Panel, Skeleton } from "../components/Shell.js";
import { StateBadge } from "../components/StateBadge.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogTrigger } from "../components/ui/dialog.js";
import { Field, Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { fmtDate, fmtNum, relTime } from "../lib/format.js";
import {
  useAiBulk,
  useAiBulkStatus,
  useAiStatus,
  useBudget,
  useConfig,
  useEngineAction,
  useForceSearch,
  useHuntPaused,
  useHuntQueue,
  useHuntStatus,
  useMovieDetail,
  useQueueBump,
  useQueueRemove,
  useResumeItem,
  useSeriesDetail,
  useTypeahead,
  useUpdateConfig,
} from "../lib/queries.js";
import { STATE_META } from "../lib/states.js";
import { cn } from "../lib/utils.js";

type SubjectDetail = SeriesDetail | MovieDetail;
type PauseListKind = "manual" | "ai";
const TRAILING_ZERO_RE = /\.0$/;

export function HuntPage() {
  const status = useHuntStatus();
  const queue = useHuntQueue();
  const paused = useHuntPaused();
  const budget = useBudget();
  const config = useConfig();
  const [pauseList, setPauseList] = useState<PauseListKind | null>(null);

  const manualCount = paused.data?.userPaused.length ?? 0;
  const aiTargetCount =
    paused.data?.aiDormant.reduce((sum, item) => sum + item.targetCount, 0) ?? 0;
  const queueCounts = queue.data?.counts ?? countQueueItems(queue.data?.items ?? []);
  const queueTotal = queue.data?.total ?? queue.data?.items.length ?? 0;
  const commandCeiling = config.data
    ? (60 / config.data.settings.huntTickMinutes) * config.data.settings.maxCommandsPerCycle
    : null;
  const p1 = (budget.data?.indexers ?? []).filter(
    (indexer) => indexer.enabled && indexer.priority === 1,
  );
  const p1Rate = minimumRate(p1);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-3">
      <HuntHeader
        status={status.data}
        settings={config.data?.settings}
        indexers={budget.data?.indexers ?? []}
      />

      <div className="grid grid-cols-2 divide-x divide-y divide-line rounded-[6px] border border-line bg-surface sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
        <Fact label="Eligible now" value={queue.isPending ? null : queueTotal} />
        <Fact label="Sonarr" value={queue.isPending ? null : queueCounts.sonarr} />
        <Fact label="Radarr" value={queue.isPending ? null : queueCounts.radarr} />
        <Fact label="Paused targets" value={manualCount + aiTargetCount} />
        <Fact
          label="Command ceiling"
          value={commandCeiling == null ? null : `${fmtCompact(commandCeiling)}/h`}
        />
        <Fact
          label="P1 budget pace"
          value={p1Rate == null ? "unlimited" : `${fmtCompact(p1Rate)} q/h`}
          tone={p1.some((indexer) => !indexer.canHuntNow) ? "warn" : "normal"}
        />
      </div>

      <Panel title="Decision path now">
        {status.isPending ? (
          <Skeleton className="m-3 h-20" />
        ) : status.data ? (
          <DecisionTable status={status.data} />
        ) : (
          <EmptyState message="Hunt status unavailable." />
        )}
      </Panel>

      <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(300px,0.8fr)]">
        <Panel
          title="Next hunts"
          actions={
            queue.data ? (
              <span className="font-mono text-[10px] text-faint">
                {queueCounts.forced} forced · {queueCounts.retry} retries
              </span>
            ) : null
          }
        >
          {queue.isPending ? (
            <Skeleton className="m-3 h-52" />
          ) : queue.data?.items.length ? (
            <div className="divide-y divide-line">
              {queue.data.items.slice(0, 10).map((item) => (
                <QueueRow key={item.id} item={item} />
              ))}
              {queueTotal > 10 ? (
                <div className="px-3 py-2 text-[11px] text-faint">
                  Showing 10 of {fmtNum(queueTotal)} eligible targets. The engine keeps the complete
                  ranked list.
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState message="No title is eligible right now." />
          )}
        </Panel>

        <Panel title="Paused">
          {paused.isPending ? (
            <Skeleton className="m-3 h-24" />
          ) : (
            <div className="divide-y divide-line">
              <PauseSummaryRow
                icon={<Pause size={14} className="text-userpaused" />}
                label="Manual pauses"
                count={manualCount}
                hint="Explicitly held by you"
                onClick={() => setPauseList("manual")}
              />
              <PauseSummaryRow
                icon={<Sparkles size={14} style={{ color: STATE_META.ai_paused.color }} />}
                label="AI dormant"
                count={aiTargetCount}
                hint={`${paused.data?.aiDormant.length ?? 0} grouped titles`}
                onClick={() => setPauseList("ai")}
              />
            </div>
          )}
        </Panel>
      </div>

      <Dialog open={pauseList !== null} onOpenChange={(open) => !open && setPauseList(null)}>
        <DialogContent
          title={pauseList === "manual" ? "Manual pauses" : "AI-dormant titles"}
          description="Details stay out of the main hunt view until you need them."
          className="max-h-[calc(100vh-32px)] w-[760px] overflow-y-auto"
        >
          {pauseList ? (
            <PausedList
              kind={pauseList}
              manual={paused.data?.userPaused ?? []}
              ai={paused.data?.aiDormant ?? []}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HuntHeader({
  status,
  settings,
  indexers,
}: {
  status?: HuntStatusResponse;
  settings?: AppSettingsDto;
  indexers: IndexerBudget[];
}) {
  const engine = useEngineAction();
  const subtitle = status?.current
    ? `Searching ${status.current.label}`
    : status?.holdReason
      ? status.holdReason
      : `Next decision ${relTime(status?.nextTickAt ?? null)}`;
  return (
    <header className="flex min-h-10 flex-wrap items-center gap-2 border-b border-line pb-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="text-[16px] font-semibold text-ink">Hunt</h1>
          <EngineLabel status={status} />
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted">{subtitle}</p>
      </div>

      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Search size={13} /> Find or force
          </Button>
        </DialogTrigger>
        <DialogContent title="Find or force a title" className="w-[720px]">
          <HuntInspector />
        </DialogContent>
      </Dialog>

      {settings && status ? (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">
              <SlidersHorizontal size={13} /> Controls
            </Button>
          </DialogTrigger>
          <DialogContent
            title="Hunt controls"
            description="Change a guardrail and see its operational effect before saving."
            className="max-h-[calc(100vh-32px)] w-[860px] overflow-y-auto"
          >
            <HuntControls settings={settings} status={status} indexers={indexers} />
          </DialogContent>
        </Dialog>
      ) : null}

      <Button variant="ghost" size="sm" onClick={() => engine.mutate("cycle")}>
        Run now
      </Button>
      {status?.engine === "paused" ? (
        <Button variant="primary" size="sm" onClick={() => engine.mutate("resume")}>
          <Play size={12} /> Resume
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => engine.mutate("pause")}>
          <Pause size={12} /> Pause
        </Button>
      )}
    </header>
  );
}

function EngineLabel({ status }: { status?: HuntStatusResponse }) {
  const label =
    status?.engine === "paused"
      ? "paused"
      : status?.current
        ? "searching"
        : status?.holdReason
          ? "held"
          : "running";
  return (
    <span
      className={cn(
        "rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px]",
        label === "running" || label === "searching"
          ? "border-german/30 text-german"
          : "border-nongerman/30 text-nongerman",
      )}
    >
      {label}
    </span>
  );
}

function Fact({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string | number | null;
  tone?: "normal" | "warn";
}) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className={cn("font-mono text-[17px]", tone === "warn" ? "text-nongerman" : "text-ink")}>
        {value ?? "—"}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-muted">{label}</div>
    </div>
  );
}

function DecisionTable({ status }: { status: HuntStatusResponse }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="h-8 border-b border-line text-left">
            <th className="microlabel px-3">Source</th>
            <th className="microlabel hidden px-3 sm:table-cell">Connection</th>
            <th className="microlabel px-3">Downloads</th>
            <th className="microlabel hidden px-3 md:table-cell">Queue protection</th>
            <th className="microlabel px-3">Decision</th>
          </tr>
        </thead>
        <tbody>
          {(["sonarr", "radarr"] as const).map((source) => {
            const queue = status.queueGate[source];
            const health = status.arrHealth[source];
            const ready = health === "up" && queue.open && status.engine !== "paused";
            return (
              <tr key={source} className="h-10 border-b border-line last:border-b-0">
                <td className="px-3 font-medium text-ink">{source}</td>
                <td
                  className={cn(
                    "hidden px-3 sm:table-cell",
                    health === "up" ? "text-german" : "text-missing",
                  )}
                >
                  {health}
                </td>
                <td className="px-3 font-mono text-ink">{fmtNum(queue.size)}</td>
                <td className="hidden px-3 text-muted md:table-cell">
                  {status.queueGate.enabled !== false
                    ? `limit ${fmtNum(status.queueGate.threshold)}`
                    : "off"}
                </td>
                <td className={cn("px-3 font-medium", ready ? "text-german" : "text-nongerman")}>
                  {status.engine === "paused"
                    ? "Engine paused"
                    : health !== "up"
                      ? "Connection blocks hunts"
                      : queue.open
                        ? "May hunt"
                        : `${fmtNum(queue.size - status.queueGate.threshold)} over queue limit`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QueueRow({ item }: { item: HuntQueueItem }) {
  const navigate = useNavigate();
  const bump = useQueueBump();
  const remove = useQueueRemove();

  const openTitle = () => {
    if (item.source === "sonarr" && item.seriesId != null) {
      void navigate({
        to: "/library/series/$seriesId",
        params: { seriesId: String(item.seriesId) },
        search: {},
      });
    } else if (item.source === "radarr") {
      void navigate({
        to: "/library/movies/$movieId",
        params: { movieId: String(item.targetId) },
        search: {},
      });
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="grid min-h-10 w-full cursor-pointer grid-cols-[24px_minmax(0,1fr)_18px] items-center gap-2 px-3 text-left hover:bg-raised sm:grid-cols-[32px_minmax(0,1fr)_70px_76px_18px]"
        >
          <span className="font-mono text-[10px] text-faint">{item.position}</span>
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-medium text-ink">{item.title}</span>
            <span className="block truncate text-[10px] text-muted">{item.scopeLabel}</span>
          </span>
          <span className="hidden font-mono text-[10px] text-muted sm:block">{item.source}</span>
          <span className="hidden text-[10px] text-muted sm:block">{reasonLabel(item.reason)}</span>
          <ChevronRight size={13} className="text-faint" />
        </button>
      </DialogTrigger>
      <DialogContent title={item.title} description={item.scopeLabel || undefined}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-line py-3 text-[12px]">
          <Detail label="Position" value={`#${item.position}`} />
          <Detail label="Source" value={item.source} />
          <Detail label="Reason" value={reasonLabel(item.reason)} />
          <Detail
            label="Priority score"
            value={Number.isFinite(item.score) ? fmtNum(Math.round(item.score)) : "not available"}
          />
          <Detail label="Target kind" value={item.kind} />
          <Detail
            label="Estimated queries"
            value={
              item.estimatedQueries == null ? "calculated when grouped" : item.estimatedQueries
            }
          />
        </dl>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="danger" size="sm" onClick={() => remove.mutate(item.id)}>
            Skip once
          </Button>
          <Button variant="outline" size="sm" onClick={() => bump.mutate(item.id)}>
            Move to front
          </Button>
          <Button variant="primary" size="sm" onClick={openTitle}>
            Open title <ArrowRight size={12} />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-[10px] text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-ink">{value}</dd>
    </div>
  );
}

function PauseSummaryRow({
  icon,
  label,
  count,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-h-14 w-full cursor-pointer items-center gap-3 px-3 text-left hover:bg-raised"
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium text-ink">{label}</span>
        <span className="block truncate text-[10px] text-muted">{hint}</span>
      </span>
      <span className="font-mono text-[18px] text-ink">{fmtNum(count)}</span>
      <ChevronRight size={13} className="text-faint" />
    </button>
  );
}

function PausedList({
  kind,
  manual,
  ai,
}: {
  kind: PauseListKind;
  manual: PausedItem[];
  ai: AiDormantItem[];
}) {
  const resume = useResumeItem();
  const items = kind === "manual" ? manual : ai;
  if (items.length === 0) return <EmptyState message="Nothing in this list." />;
  return (
    <div className="divide-y divide-line border-y border-line">
      {kind === "manual"
        ? manual.map((item) => (
            <div
              key={`${item.source}:${item.kind}:${item.targetId}`}
              className="flex items-start gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-ink">{item.title}</div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {item.note ?? "Manually paused"}
                </div>
                <div className="mt-1 font-mono text-[10px] text-faint">
                  {item.until
                    ? `wakes ${relTime(item.until)} · ${fmtDate(item.until)}`
                    : "indefinite"}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  resume.mutate({
                    ref: { source: item.source, kind: item.kind, id: item.targetId },
                  })
                }
              >
                <Play size={12} /> Resume
              </Button>
            </div>
          ))
        : ai.map((item) => (
            <div
              key={`${item.source}:${item.kind}:${item.targetId}:${item.verdictId}`}
              className="flex items-start gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12px] font-medium text-ink">{item.title}</span>
                  <span className="font-mono text-[10px] text-muted">
                    {item.targetCount} targets
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {item.verdict} · confidence {item.confidence.toFixed(2)} · wakes{" "}
                  {relTime(item.wakeAt)}
                </div>
                {item.evidence[0] ? (
                  <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-faint">
                    {item.evidence[0]}
                  </p>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  resume.mutate({
                    ref: { source: item.source, kind: item.kind, id: item.targetId },
                    body: { overrideAi: true },
                  })
                }
              >
                Override
              </Button>
            </div>
          ))}
    </div>
  );
}

function HuntControls({
  settings,
  status,
  indexers,
}: {
  settings: AppSettingsDto;
  status: HuntStatusResponse;
  indexers: IndexerBudget[];
}) {
  const update = useUpdateConfig();
  const aiStatus = useAiStatus();
  const aiBulkStatus = useAiBulkStatus();
  const aiBulk = useAiBulk();
  const [form, setForm] = useState({
    queueGateEnabled: settings.queueGateEnabled ?? true,
    queueGateThreshold: settings.queueGateThreshold,
    huntTickMinutes: settings.huntTickMinutes,
    maxCommandsPerCycle: settings.maxCommandsPerCycle,
    missingToUpgradeRatio: settings.missingToUpgradeRatio,
    huntSpecials: settings.huntSpecials,
    aiDailyLimitEnabled: settings.aiDailyLimitEnabled,
    aiMaxChecksPerDay: settings.aiMaxChecksPerDay,
    aiParallelism: settings.aiParallelism,
  });
  const cyclesPerHour = 60 / Math.max(1, form.huntTickMinutes);
  const ceilingPerHour = cyclesPerHour * form.maxCommandsPerCycle;
  const p1 = indexers.filter((indexer) => indexer.enabled && indexer.priority === 1);
  const p1Rate = minimumRate(p1);
  const estimatedMovieBatchesPerHour = p1Rate == null ? null : p1Rate / 3;
  const gateResults = (["sonarr", "radarr"] as const).map((source) => ({
    source,
    size: status.queueGate[source].size,
    open: !form.queueGateEnabled || status.queueGate[source].size <= form.queueGateThreshold,
  }));
  const setNumber =
    (
      key:
        | "queueGateThreshold"
        | "huntTickMinutes"
        | "maxCommandsPerCycle"
        | "aiMaxChecksPerDay"
        | "aiParallelism",
    ) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number.parseInt(event.target.value, 10);
      setForm((current) => ({ ...current, [key]: Number.isNaN(value) ? 0 : value }));
    };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="divide-y divide-line border-y border-line">
        <ControlRow
          label="Download queue protection"
          description="When enabled, each arr stops scheduled hunts above its queue limit. Forced hunts still pass."
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-ink">
              {form.queueGateEnabled ? "Protection on" : "Protection off"}
            </span>
            <Switch
              checked={form.queueGateEnabled}
              onCheckedChange={(value) =>
                setForm((current) => ({ ...current, queueGateEnabled: value }))
              }
            />
          </div>
        </ControlRow>

        <ControlRow
          label="Queue limit per arr"
          description="Scheduled hunts resume independently when Sonarr or Radarr is at or below this count."
        >
          <RangeControl
            value={form.queueGateThreshold}
            min={1}
            max={1000}
            step={1}
            disabled={!form.queueGateEnabled}
            onChange={setNumber("queueGateThreshold")}
            suffix="items"
          />
        </ControlRow>

        <ControlRow
          label="Decision interval"
          description="How often fresh library, queue and indexer data are evaluated. Applies immediately after saving."
        >
          <RangeControl
            value={form.huntTickMinutes}
            min={1}
            max={120}
            step={1}
            onChange={setNumber("huntTickMinutes")}
            suffix="min"
          />
        </ControlRow>

        <ControlRow
          label="Safety ceiling per cycle"
          description="Budget remains the actual throttle. This prevents one cycle from producing an unlimited burst."
        >
          <RangeControl
            value={form.maxCommandsPerCycle}
            min={1}
            max={50}
            step={1}
            onChange={setNumber("maxCommandsPerCycle")}
            suffix="commands"
          />
        </ControlRow>

        <ControlRow
          label="Missing : upgrade mix"
          description="Interleave missing media and German-audio upgrades in this ratio."
        >
          <Field label="Ratio">
            <Input
              value={form.missingToUpgradeRatio}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  missingToUpgradeRatio: event.target.value,
                }))
              }
              className="w-24 font-mono"
            />
          </Field>
        </ControlRow>

        <ControlRow
          label="Season zero"
          description="Include specials in automatic hunting. Their language metadata is often less reliable."
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-ink">Hunt specials</span>
            <Switch
              checked={form.huntSpecials}
              onCheckedChange={(value) =>
                setForm((current) => ({ ...current, huntSpecials: value }))
              }
            />
          </div>
        </ControlRow>

        <ControlRow
          label="Daily AI limit"
          description="Limits paid AI title analyses per UTC day. Turn it off for the initial backlog; catalog matches do not consume this allowance."
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-ink">
              {form.aiDailyLimitEnabled ? "Limit on" : "Unlimited"}
            </span>
            <Switch
              checked={form.aiDailyLimitEnabled}
              onCheckedChange={(value) =>
                setForm((current) => ({ ...current, aiDailyLimitEnabled: value }))
              }
            />
          </div>
        </ControlRow>

        <ControlRow
          label="AI analyses per day"
          description="Only applies while the daily AI limit is enabled."
        >
          <RangeControl
            value={form.aiMaxChecksPerDay}
            min={0}
            max={500}
            step={5}
            disabled={!form.aiDailyLimitEnabled}
            onChange={setNumber("aiMaxChecksPerDay")}
            suffix="titles"
          />
        </ControlRow>

        <ControlRow
          label="Parallel AI jobs"
          description="Different films or series analyzed at the same time. A series remains one job even when it contains many seasons."
        >
          <RangeControl
            value={form.aiParallelism}
            min={1}
            max={10}
            step={1}
            onChange={setNumber("aiParallelism")}
            suffix="jobs"
          />
        </ControlRow>

        <ControlRow
          label="Initial AI bulk"
          description="Checks every currently due title. Wikidata/Synchronkartei matches are resolved first; AI handles only remaining films and season details."
        >
          <div className="space-y-2">
            <div className="font-mono text-[10px] text-muted">
              {aiBulkStatus.data?.running
                ? `${fmtNum(aiBulkStatus.data.completed)} done · ${fmtNum(aiBulkStatus.data.remaining)} left · ${aiBulkStatus.data.active.length} active`
                : aiBulkStatus.data?.completedAt
                  ? `${fmtNum(aiBulkStatus.data.completed)} completed · ${fmtNum(aiBulkStatus.data.failed)} failed · ${fmtNum(aiBulkStatus.data.remaining)} left`
                  : "Not started"}
            </div>
            {aiBulkStatus.data?.running ? (
              <Button
                variant="danger"
                size="sm"
                disabled={aiBulk.isPending}
                onClick={() => aiBulk.mutate({ action: "cancel" })}
              >
                <X size={12} /> Cancel bulk
              </Button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    aiBulk.isPending ||
                    update.isPending ||
                    settings.dryRun ||
                    settings.aiProvider === "off"
                  }
                  onClick={() => {
                    void update
                      .mutateAsync(form)
                      .then(() => aiBulk.mutate({ action: "start", limit: 25 }));
                  }}
                >
                  <Sparkles size={12} /> Validate 25
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    aiBulk.isPending ||
                    update.isPending ||
                    settings.dryRun ||
                    settings.aiProvider === "off"
                  }
                  onClick={() => {
                    void update.mutateAsync(form).then(() => aiBulk.mutate({ action: "start" }));
                  }}
                >
                  Start full bulk
                </Button>
              </div>
            )}
          </div>
        </ControlRow>
      </div>

      <aside className="self-start border border-line bg-bg">
        <div className="border-b border-line px-3 py-2 text-[12px] font-medium text-ink">
          Effect with live data
        </div>
        <div className="divide-y divide-line">
          {gateResults.map((result) => (
            <div key={result.source} className="flex items-center gap-2 px-3 py-2.5">
              {form.queueGateEnabled ? (
                result.open ? (
                  <ShieldCheck size={14} className="text-german" />
                ) : (
                  <ShieldOff size={14} className="text-nongerman" />
                )
              ) : (
                <ShieldOff size={14} className="text-muted" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium text-ink">{result.source}</div>
                <div className="text-[10px] text-muted">
                  {fmtNum(result.size)} downloads · {result.open ? "hunts open" : "hunts blocked"}
                </div>
              </div>
            </div>
          ))}
          <ImpactLine
            icon={<Clock3 size={14} />}
            label="Cycles"
            value={`${fmtCompact(cyclesPerHour)}/h`}
          />
          <ImpactLine
            icon={<Gauge size={14} />}
            label="Command ceiling"
            value={`${fmtCompact(ceilingPerHour)}/h`}
          />
          <ImpactLine
            icon={<ListFilter size={14} />}
            label="Tightest P1 pace"
            value={p1Rate == null ? "unlimited" : `${fmtCompact(p1Rate)} queries/h`}
          />
          <ImpactLine
            icon={<Sparkles size={14} />}
            label="AI allowance"
            value={
              form.aiDailyLimitEnabled
                ? `${fmtNum(aiStatus.data?.checksToday ?? 0)}/${fmtNum(form.aiMaxChecksPerDay)} today`
                : `unlimited · ${form.aiParallelism} parallel`
            }
          />
        </div>
        {estimatedMovieBatchesPerHour != null &&
        ceilingPerHour < estimatedMovieBatchesPerHour * 0.8 ? (
          <div className="border-t border-nongerman/30 bg-nongerman/5 px-3 py-2.5 text-[10px] leading-4 text-nongerman">
            The scheduler is the likely bottleneck. Current P1 pace can fund roughly{" "}
            {fmtCompact(estimatedMovieBatchesPerHour)} three-title movie batches per hour, but this
            ceiling allows {fmtCompact(ceilingPerHour)}.
          </div>
        ) : null}
        <p className="border-t border-line px-3 py-2.5 text-[10px] leading-4 text-faint">
          The command ceiling is not a target. Every grouped command still has to pass all enabled
          indexer budgets. A movie command usually represents up to three searches per indexer.
        </p>
      </aside>

      <div className="flex justify-end gap-2 lg:col-span-2">
        <Button variant="primary" disabled={update.isPending} onClick={() => update.mutate(form)}>
          Save hunt controls
        </Button>
      </div>
    </div>
  );
}

function ControlRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_190px] md:items-center">
      <div>
        <div className="text-[12px] font-medium text-ink">{label}</div>
        <p className="mt-0.5 text-[11px] leading-4 text-muted">{description}</p>
      </div>
      <div>{children}</div>
    </div>
  );
}

function RangeControl({
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  disabled?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        value={Math.min(max, Math.max(min, value))}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={onChange}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-accent disabled:opacity-40"
      />
      <div className="flex items-baseline gap-1">
        <Input
          type="number"
          value={value}
          min={min}
          step={step}
          disabled={disabled}
          onChange={onChange}
          className="w-20 font-mono"
        />
        <span className="w-14 text-[10px] text-muted">{suffix}</span>
      </div>
    </div>
  );
}

function ImpactLine({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 text-muted">
      {icon}
      <span className="min-w-0 flex-1 text-[10px]">{label}</span>
      <span className="font-mono text-[11px] text-ink">{value}</span>
    </div>
  );
}

function HuntInspector() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [season, setSeason] = useState("");
  const typeahead = useTypeahead(q);
  const force = useForceSearch();
  const seriesDetail = useSeriesDetail(
    selected?.kind === "series" ? selected.id : 0,
    false,
    selected?.kind === "series",
  );
  const movieDetail = useMovieDetail(
    selected?.kind === "movie" ? selected.id : 0,
    false,
    selected?.kind === "movie",
  );
  const detail = selected?.kind === "series" ? seriesDetail.data : movieDetail.data;
  const detailPending = selected
    ? selected.kind === "series"
      ? seriesDetail.isPending
      : movieDetail.isPending
    : false;

  const openDetail = (target: SearchResult, live = false) => {
    if (target.kind === "series") {
      void navigate({
        to: "/library/series/$seriesId",
        params: { seriesId: String(target.id) },
        search: { season: season === "" ? undefined : Number(season), live: live || undefined },
      });
      return;
    }
    void navigate({
      to: "/library/movies/$movieId",
      params: { movieId: String(target.id) },
      search: { live: live || undefined },
    });
  };

  const dispatch = () => {
    if (!selected) return;
    const target = selected;
    const seasonNumber = season === "" ? undefined : Number(season);
    force.mutate(
      {
        ref: { source: target.source, kind: target.kind, id: target.id },
        body: {
          ...(seasonNumber !== undefined ? { scope: { seasonNumber } } : {}),
          withAiRecheck: detail?.state === "ai_paused",
        },
      },
      { onSuccess: () => openDetail(target, true) },
    );
  };

  const clear = () => {
    setSelected(null);
    setQ("");
    setSeason("");
  };

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-3 text-faint" size={14} />
        <Input
          value={selected ? selected.title : q}
          onChange={(event) => {
            if (selected) clear();
            setQ(event.target.value);
          }}
          placeholder="Search a movie or series…"
          className="h-9 pr-9 pl-9 text-[13px]"
        />
        {selected ? (
          <button
            type="button"
            className="absolute top-2.5 right-3 cursor-pointer text-muted hover:text-ink"
            onClick={clear}
            title="Clear selection"
          >
            <X size={14} />
          </button>
        ) : null}
        {!selected && q.trim().length >= 2 && typeahead.data ? (
          <div className="absolute top-10 right-0 left-0 z-20 max-h-[280px] overflow-y-auto rounded-[6px] border border-line bg-surface p-1 shadow-lg">
            {typeahead.data.items.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-faint">No matches.</div>
            ) : (
              typeahead.data.items.map((item) => (
                <button
                  key={`${item.source}:${item.id}`}
                  type="button"
                  className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-[4px] px-2 text-left hover:bg-raised"
                  onClick={() => {
                    setSelected(item);
                    setQ("");
                  }}
                >
                  <span className="microlabel w-12">
                    {item.source === "sonarr" ? "series" : "movie"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {item.title}
                    {item.year ? (
                      <span className="ml-1.5 font-mono text-[10px] text-muted">{item.year}</span>
                    ) : null}
                  </span>
                  <StateBadge state={item.state} />
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

      {selected ? (
        detailPending ? (
          <Skeleton className="mt-3 h-24 w-full" />
        ) : detail ? (
          <SubjectInspection
            selected={selected}
            detail={detail}
            season={season}
            setSeason={setSeason}
            onOpen={() => openDetail(selected)}
            onForce={dispatch}
            forcing={force.isPending}
          />
        ) : null
      ) : (
        <p className="mt-2 text-[11px] text-faint">
          Select a title to inspect its current state or force it ahead of scheduled work.
        </p>
      )}
    </div>
  );
}

function SubjectInspection({
  selected,
  detail,
  season,
  setSeason,
  onOpen,
  onForce,
  forcing,
}: {
  selected: SearchResult;
  detail: SubjectDetail;
  season: string;
  setSeason: (value: string) => void;
  onOpen: () => void;
  onForce: () => void;
  forcing: boolean;
}) {
  const waitUntil = detail.pause.paused
    ? detail.pause.until
    : detail.state === "ai_paused"
      ? (detail.verdict?.recheckAfter ?? detail.nextSearchAt)
      : detail.nextSearchAt;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-ink">{detail.title}</span>
            <StateBadge state={detail.state} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
            <span>{waitUntil ? `eligible ${relTime(waitUntil)}` : "eligible now"}</span>
            <span className="font-mono">last search {relTime(detail.lastSearchAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selected.kind === "series" ? (
            <Input
              value={season}
              onChange={(event) => setSeason(event.target.value.replace(/[^0-9]/g, ""))}
              placeholder="Season (optional)"
              className="w-40 font-mono"
            />
          ) : null}
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Details <ArrowRight size={12} />
          </Button>
          <Button variant="primary" size="sm" disabled={forcing} onClick={onForce}>
            <Zap size={13} /> Force now
          </Button>
        </div>
      </div>
    </div>
  );
}

function minimumRate(indexers: IndexerBudget[]): number | null {
  const rates = indexers
    .map((indexer) => indexer.huntRatePerHour)
    .filter((rate): rate is number => rate != null);
  return rates.length ? Math.min(...rates) : null;
}

function countQueueItems(items: HuntQueueItem[]) {
  return {
    sonarr: items.filter((item) => item.source === "sonarr").length,
    radarr: items.filter((item) => item.source === "radarr").length,
    forced: items.filter((item) => item.reason === "forced").length,
    scheduled: items.filter((item) => item.reason === "scheduled").length,
    retry: items.filter((item) => item.reason === "retry").length,
  };
}

function reasonLabel(reason: HuntQueueItem["reason"]): string {
  return reason === "forced" ? "forced" : reason === "retry" ? "retry" : "scheduled";
}

function fmtCompact(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(TRAILING_ZERO_RE, "");
}
