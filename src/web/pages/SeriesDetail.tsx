import { useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw, Zap } from "lucide-react";
import { useState } from "react";
import type { EpisodeItem, SeasonItem, SeriesDetail } from "../../shared/api-types.js";
import { ForceControl, PauseControl, ResumeControl } from "../components/ItemActions.js";
import { SegmentedBar } from "../components/SegmentedBar.js";
import { DataTable, EmptyState, ErrorState, Panel, Skeleton, Td, Th } from "../components/Shell.js";
import { StateBadge } from "../components/StateBadge.js";
import { Button } from "../components/ui/button.js";
import { epLabel, fmtDate, fmtDateTime, relTime } from "../lib/format.js";
import { useForceSearch, useInvalidateVerdict, useSeriesDetail } from "../lib/queries.js";
import { cn } from "../lib/utils.js";

export function SeriesDetailPage() {
  const { seriesId } = useParams({ strict: false }) as { seriesId: string };
  const id = Number(seriesId);
  const detail = useSeriesDetail(id);

  if (detail.isPending) {
    return (
      <div className="mx-auto max-w-[1100px] space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return <ErrorState message="Could not load this series." />;
  }
  const s = detail.data;
  return <SeriesDetailView s={s} />;
}

function SeriesDetailView({ s }: { s: SeriesDetail }) {
  const itemRef = { source: "sonarr", kind: "series", id: s.id } as const;
  const invalidate = useInvalidateVerdict();
  const seasons = s.seasons.map((x) => x.seasonNumber);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
      {/* header */}
      <Panel className="p-4">
        <div className="flex gap-4">
          {s.posterUrl ? (
            <img
              src={s.posterUrl}
              alt=""
              className="h-36 w-24 shrink-0 rounded-[4px] border border-line object-cover"
            />
          ) : (
            <div className="h-36 w-24 shrink-0 rounded-[4px] border border-line bg-raised" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[17px] font-semibold tracking-tight text-ink">{s.title}</h1>
              {s.year ? <span className="font-mono text-[12px] text-muted">{s.year}</span> : null}
              <StateBadge
                state={s.pause.paused ? "user_paused" : s.state}
                searching={s.searching}
              />
              {s.arrUrl ? (
                <a
                  href={s.arrUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted hover:text-ink"
                  title="Open in Sonarr"
                >
                  <ExternalLink size={13} />
                </a>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-muted">
              <span>
                German {s.germanEpisodes}/{s.consideredEpisodes}
              </span>
              {s.originalLanguage ? <span>original {s.originalLanguage}</span> : null}
              {s.status ? <span>{s.status}</span> : null}
              {s.path ? <span className="truncate">{s.path}</span> : null}
            </div>
            <SegmentedBar counts={s.episodeCounts} scale="hero" className="mt-3" />
            {s.pause.paused ? (
              <p className="mt-2 text-[12px] text-userpaused">
                Paused {s.pause.until ? `until ${fmtDate(s.pause.until)}` : "indefinitely"}
                {s.pause.note ? ` — ${s.pause.note}` : ""}
              </p>
            ) : null}
            {/* action row */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ForceControl itemRef={itemRef} seasons={seasons} withAiRecheckOption />
              {s.pause.paused || s.state === "ai_paused" ? (
                <ResumeControl
                  itemRef={itemRef}
                  aiPaused={s.state === "ai_paused"}
                  verdict={s.verdict}
                />
              ) : (
                <PauseControl itemRef={itemRef} />
              )}
            </div>
          </div>
          {/* AI verdict card */}
          <div className="hidden w-[260px] shrink-0 rounded-[6px] border border-line bg-bg p-3 md:block">
            <div className="flex items-center justify-between">
              <span className="microlabel">AI dub verdict</span>
              {s.verdict ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => invalidate.mutate(s.verdict?.id ?? 0)}
                  title="Invalidate & re-check"
                >
                  <RefreshCw size={11} />
                  Re-check
                </Button>
              ) : null}
            </div>
            {s.verdict ? (
              <>
                <div className="mt-1.5 font-mono text-[13px] text-ink">
                  {s.verdict.verdict} · {s.verdict.confidence.toFixed(2)}
                </div>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] text-muted">
                  {s.verdict.evidence.slice(0, 4).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                <div className="mt-2 font-mono text-[10px] text-faint">
                  checked {relTime(s.verdict.checkedAt)} · recheck {relTime(s.verdict.recheckAfter)}
                </div>
              </>
            ) : (
              <p className="mt-2 text-[12px] text-faint">Not checked yet.</p>
            )}
          </div>
        </div>
      </Panel>

      {/* seasons accordion */}
      <div className="flex flex-col gap-2">
        {s.seasons.length === 0 ? (
          <Panel>
            <EmptyState message="No seasons mirrored yet." />
          </Panel>
        ) : (
          s.seasons.map((season) => (
            <SeasonSection key={season.seasonNumber} season={season} seriesId={s.id} />
          ))
        )}
      </div>

      {/* history timeline */}
      <Panel title="History">
        {s.history.length === 0 ? (
          <EmptyState message="No history yet for this series." />
        ) : (
          <ul className="p-3">
            {s.history.map((h, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: server-ordered timeline, entries never reorder
                key={`${h.at}-${i}-${h.kind}`}
                className="relative flex gap-3 border-l border-line pb-3 pl-4 last:pb-0"
              >
                <span className="absolute top-1 -left-[3px] h-1.5 w-1.5 rounded-full bg-line" />
                <span className="w-32 shrink-0 font-mono text-[10px] text-faint">
                  {fmtDateTime(h.at)}
                </span>
                <span className="microlabel w-16 shrink-0">{h.kind}</span>
                <span className="min-w-0 text-[12px] text-muted">{h.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function SeasonSection({ season, seriesId }: { season: SeasonItem; seriesId: number }) {
  const [open, setOpen] = useState(false);
  const force = useForceSearch();
  const total = season.episodes.length;

  return (
    <Panel>
      <header className="flex h-9 items-center gap-3 px-3">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-2 text-[12px] font-medium text-ink"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Season {season.seasonNumber}
          {!season.monitored ? <span className="microlabel">unmonitored</span> : null}
        </button>
        <SegmentedBar counts={season.counts} scale="season" className="max-w-[200px] flex-1" />
        <span className="ml-auto font-mono text-[11px] text-muted">{total} eps</span>
        <Button
          variant="ghost"
          size="sm"
          title={`Force search season ${season.seasonNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            force.mutate({
              ref: { source: "sonarr", kind: "series", id: seriesId },
              body: { scope: { seasonNumber: season.seasonNumber } },
            });
          }}
        >
          <Zap size={12} />
          Force
        </Button>
      </header>
      {open ? (
        <div className="border-t border-line">
          <DataTable
            head={
              <>
                <Th className="w-16">Ep</Th>
                <Th>Title</Th>
                <Th>Air date</Th>
                <Th>State</Th>
                <Th>Langs</Th>
                <Th>Quality</Th>
                <Th>Last search</Th>
                <Th className="text-right">Force</Th>
              </>
            }
          >
            {season.episodes.map((ep) => (
              <EpisodeRow key={ep.id} ep={ep} />
            ))}
          </DataTable>
        </div>
      ) : null}
    </Panel>
  );
}

function EpisodeRow({ ep }: { ep: EpisodeItem }) {
  const force = useForceSearch();
  return (
    <tr className="h-8 border-b border-line last:border-b-0">
      <Td>
        <span className="font-mono text-[11px] text-muted">
          {epLabel(ep.seasonNumber, ep.episodeNumber)}
        </span>
      </Td>
      <Td>
        <span className="max-w-[280px] truncate text-[12px] text-ink">{ep.title ?? "TBA"}</span>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{fmtDate(ep.airDateUtc)}</span>
      </Td>
      <Td>
        <StateBadge state={ep.state} searching={ep.searching} />
      </Td>
      <Td>
        <span className="flex gap-1">
          {ep.languages.map((lang) => (
            <span
              key={lang}
              className={cn(
                "rounded-[3px] border px-1 font-mono text-[10px] uppercase",
                lang.toLowerCase().startsWith("ger")
                  ? "border-german/50 text-german"
                  : "border-line text-muted",
              )}
            >
              {lang.slice(0, 3)}
            </span>
          ))}
        </span>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{ep.quality ?? "—"}</span>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">
          {relTime(ep.lastSearchAt)}
          {ep.searchCount > 0 ? ` ·${ep.searchCount}×` : ""}
        </span>
      </Td>
      <Td>
        <span className="flex justify-end">
          <Button
            variant="ghost"
            size="icon"
            title="Force search this episode"
            onClick={() => force.mutate({ ref: { source: "sonarr", kind: "episode", id: ep.id } })}
          >
            <Zap size={12} />
          </Button>
        </span>
      </Td>
    </tr>
  );
}
