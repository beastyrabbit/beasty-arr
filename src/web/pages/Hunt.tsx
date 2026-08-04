import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Clock3, Pause, Play, Search, Sparkles, X, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AiDormantItem,
  MovieDetail,
  PausedItem,
  SearchResult,
  SeriesDetail,
} from "../../shared/api-types.js";
import type { ArrSource } from "../../shared/domain.js";
import { EmptyState, Panel, Skeleton } from "../components/Shell.js";
import { StateBadge } from "../components/StateBadge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { fmtDate, relTime } from "../lib/format.js";
import {
  useEngineAction,
  useForceSearch,
  useHuntPaused,
  useHuntStatus,
  useMovieDetail,
  useResumeItem,
  useSeriesDetail,
  useTypeahead,
} from "../lib/queries.js";
import { STATE_META } from "../lib/states.js";

type SubjectDetail = SeriesDetail | MovieDetail;

export function HuntPage() {
  const status = useHuntStatus();
  const paused = useHuntPaused();
  const engine = useEngineAction();

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-3">
      <HuntInspector />

      <Panel
        title="Hunt overview"
        actions={
          <div className="flex items-center gap-1.5">
            <span className="mr-2 font-mono text-[10px] text-faint">
              {status.data?.engine === "paused"
                ? "engine paused"
                : status.data?.current
                  ? `searching ${status.data.current.source}`
                  : `next check ${relTime(status.data?.nextTickAt ?? null)}`}
            </span>
            <Button variant="ghost" size="sm" onClick={() => engine.mutate("cycle")}>
              Run now
            </Button>
            {status.data?.engine === "paused" ? (
              <Button variant="primary" size="sm" onClick={() => engine.mutate("resume")}>
                <Play size={12} /> Resume
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => engine.mutate("pause")}>
                <Pause size={12} /> Pause
              </Button>
            )}
          </div>
        }
      >
        {paused.isPending || status.isPending ? (
          <div className="grid grid-cols-1 gap-px bg-line lg:grid-cols-2">
            <Skeleton className="h-52 rounded-none" />
            <Skeleton className="h-52 rounded-none" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-px bg-line lg:grid-cols-2">
            <SourcePauseOverview
              source="sonarr"
              manual={paused.data?.userPaused ?? []}
              ai={paused.data?.aiDormant ?? []}
              gateOpen={status.data?.queueGate.sonarr.open ?? false}
              health={status.data?.arrHealth.sonarr ?? "unknown"}
            />
            <SourcePauseOverview
              source="radarr"
              manual={paused.data?.userPaused ?? []}
              ai={paused.data?.aiDormant ?? []}
              gateOpen={status.data?.queueGate.radarr.open ?? false}
              health={status.data?.arrHealth.radarr ?? "unknown"}
            />
          </div>
        )}
      </Panel>
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
        search: {
          season: season === "" ? undefined : Number(season),
          live: live || undefined,
        },
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
    <Panel title="Find or force a title">
      <div className="p-3">
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
            Select a title to see why it is waiting, when it wakes, its AI verdict, and its recent
            hunt state before forcing a search.
          </p>
        )}
      </div>
    </Panel>
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
  const reason = detail.pause.paused
    ? (detail.pause.note ?? "Manually paused")
    : detail.state === "ai_paused"
      ? `AI: ${detail.verdict?.verdict ?? "paused"}${detail.verdict ? ` (${detail.verdict.confidence.toFixed(2)})` : ""}`
      : waitUntil && waitUntil > Date.now()
        ? "Hunt backoff"
        : "Eligible for the next hunt";

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-ink">{detail.title}</span>
            <StateBadge state={detail.state} />
            <span className="microlabel">{selected.source}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
            <span>{reason}</span>
            <span className="font-mono">
              {waitUntil
                ? `${waitUntil > Date.now() ? "wakes" : "eligible"} ${relTime(waitUntil)} · ${fmtDate(waitUntil)}`
                : "no wake date"}
            </span>
            <span className="font-mono">last search {relTime(detail.lastSearchAt)}</span>
          </div>
          {detail.verdict ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
              <Sparkles size={12} style={{ color: STATE_META.ai_paused.color }} />
              AI checked {relTime(detail.verdict.checkedAt)}; recheck{" "}
              {relTime(detail.verdict.recheckAfter)}
            </div>
          ) : null}
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

function SourcePauseOverview({
  source,
  manual,
  ai,
  gateOpen,
  health,
}: {
  source: ArrSource;
  manual: PausedItem[];
  ai: AiDormantItem[];
  gateOpen: boolean;
  health: "up" | "down" | "unknown";
}) {
  const navigate = useNavigate();
  const resume = useResumeItem();
  const sourceManual = useMemo(
    () => manual.filter((item) => item.source === source),
    [manual, source],
  );
  const sourceAi = useMemo(() => ai.filter((item) => item.source === source), [ai, source]);
  const title = source === "sonarr" ? "Sonarr · series" : "Radarr · movies";

  const openItem = (kind: PausedItem["kind"] | AiDormantItem["kind"], id: number) => {
    if (source === "sonarr") {
      if (kind === "series") {
        void navigate({
          to: "/library/series/$seriesId",
          params: { seriesId: String(id) },
          search: {},
        });
      }
      return;
    }
    void navigate({
      to: "/library/movies/$movieId",
      params: { movieId: String(id) },
      search: {},
    });
  };

  return (
    <section className="min-w-0 bg-surface">
      <header className="flex min-h-14 items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-[10px] text-faint">
            {health !== "up"
              ? `${health} connection`
              : gateOpen
                ? "ready to search"
                : "waiting for active downloads"}
          </p>
        </div>
        <div className="flex items-baseline gap-3 text-right">
          <div>
            <div className="font-mono text-lg text-ink">{sourceManual.length}</div>
            <div className="microlabel">manual</div>
          </div>
          <div>
            <div className="font-mono text-lg" style={{ color: STATE_META.ai_paused.color }}>
              {sourceAi.length}
            </div>
            <div className="microlabel">AI</div>
          </div>
        </div>
      </header>

      <div>
        {sourceAi.map((item) => (
          <div
            key={`ai:${item.kind}:${item.targetId}`}
            className="border-b border-line px-4 py-3 last:border-b-0"
          >
            <div className="flex items-start gap-3">
              <Sparkles
                className="mt-0.5 shrink-0"
                size={13}
                style={{ color: STATE_META.ai_paused.color }}
              />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="max-w-full cursor-pointer truncate text-left text-[12px] font-medium text-ink hover:underline"
                  onClick={() => openItem(item.kind, item.targetId)}
                >
                  {item.title}
                </button>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
                  <span style={{ color: STATE_META.ai_paused.color }}>
                    {item.verdict} · {item.confidence.toFixed(2)}
                  </span>
                  {item.targetCount > 1 ? <span>{item.targetCount} episodes</span> : null}
                  <span>checked {relTime(item.checkedAt)}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-muted">
                  <Clock3 size={11} />
                  wakes {relTime(item.wakeAt)} · {fmtDate(item.wakeAt)}
                </div>
                {item.evidence[0] ? (
                  <p
                    className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-faint"
                    title={item.evidence.join("\n")}
                  >
                    {item.evidence[0]}
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                title="Override AI and resume"
                onClick={() =>
                  resume.mutate({
                    ref: { source: item.source, kind: item.kind, id: item.targetId },
                    body: { overrideAi: true },
                  })
                }
              >
                <Play size={12} />
              </Button>
            </div>
          </div>
        ))}

        {sourceManual.map((item) => (
          <div
            key={`manual:${item.kind}:${item.targetId}`}
            className="border-b border-line px-4 py-3 last:border-b-0"
          >
            <div className="flex items-start gap-3">
              <Pause className="mt-0.5 shrink-0 text-userpaused" size={13} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-ink">{item.title}</div>
                <div className="mt-0.5 text-[10px] text-muted">
                  {item.note ?? "Manually paused"}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-muted">
                  <span>paused {relTime(item.since)}</span>
                  <span>
                    {item.until
                      ? `wakes ${relTime(item.until)} · ${fmtDate(item.until)}`
                      : "indefinite"}
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                title="Resume"
                onClick={() =>
                  resume.mutate({
                    ref: { source: item.source, kind: item.kind, id: item.targetId },
                  })
                }
              >
                <Play size={12} />
              </Button>
            </div>
          </div>
        ))}

        {sourceAi.length === 0 && sourceManual.length === 0 ? (
          <EmptyState
            message="No paused titles."
            hint="Everything is eligible or already resolved."
          />
        ) : null}
      </div>
    </section>
  );
}
