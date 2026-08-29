import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useState } from "react";
import type { EpisodeItem, SeasonItem, SeriesDetail } from "../../shared/api-types.js";
import { DubVerdictSummary } from "../components/DubVerdictSummary.js";
import { ForceControl, PauseControl, ResumeControl } from "../components/ItemActions.js";
import { SegmentedBar } from "../components/SegmentedBar.js";
import { DataTable, EmptyState, ErrorState, Panel, Skeleton, Td, Th } from "../components/Shell.js";
import { StateBadge } from "../components/StateBadge.js";
import { Button, buttonVariants } from "../components/ui/button.js";
import { useLatestEvent } from "../lib/events.js";
import { epLabel, fmtDate, fmtDateTime, relTime } from "../lib/format.js";
import { useForceSearch, useRecheckSubject, useSeriesDetail } from "../lib/queries.js";
import { cn } from "../lib/utils.js";

export function SeriesDetailPage() {
  const { seriesId } = useParams({ strict: false }) as { seriesId: string };
  const search = useSearch({ strict: false }) as { season?: number; live?: boolean };
  const id = Number(seriesId);
  const detail = useSeriesDetail(id, search.live === true);

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
  return (
    <SeriesDetailView
      s={s}
      selectedSeason={Number.isFinite(search.season) ? search.season : undefined}
    />
  );
}

function SeriesDetailView({ s, selectedSeason }: { s: SeriesDetail; selectedSeason?: number }) {
  const itemRef = { source: "sonarr", kind: "series", id: s.id } as const;
  const recheck = useRecheckSubject();
  const navigate = useNavigate();
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
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  title="Open in Sonarr"
                >
                  <ExternalLink size={12} /> Open in Sonarr
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
              <ForceControl
                itemRef={itemRef}
                seasons={seasons}
                withAiRecheckOption
                onForced={(scope) =>
                  navigate({
                    to: "/library/series/$seriesId",
                    params: { seriesId: String(s.id) },
                    search: { season: scope?.seasonNumber, live: true },
                    replace: true,
                  })
                }
              />
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
              <Button
                variant="ghost"
                size="sm"
                disabled={recheck.isPending}
                onClick={() => recheck.mutate(`sonarr:${s.id}`)}
                title="Run a human-forced AI check now"
              >
                <RefreshCw size={11} />
                Check now
              </Button>
            </div>
            {s.verdict ? (
              <DubVerdictSummary verdict={s.verdict} />
            ) : (
              <p className="mt-2 text-[12px] text-faint">Not checked yet.</p>
            )}
          </div>
        </div>
      </Panel>

      <LiveCheckPanel s={s} selectedSeason={selectedSeason} />

      {/* seasons accordion */}
      <div className="flex flex-col gap-2">
        {s.seasons.length === 0 ? (
          <Panel>
            <EmptyState message="No seasons mirrored yet." />
          </Panel>
        ) : (
          s.seasons.map((season) => (
            <SeasonSection
              key={season.seasonNumber}
              season={season}
              seriesId={s.id}
              initiallyOpen={season.seasonNumber === selectedSeason}
            />
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

function LiveCheckPanel({ s, selectedSeason }: { s: SeriesDetail; selectedSeason?: number }) {
  const aiStarted = useLatestEvent("ai.check.started");
  const aiCompleted = useLatestEvent("ai.check.completed");
  const subjectKey = `sonarr:${s.id}`;
  const aiRunning =
    aiStarted?.payload.subjectKey === subjectKey &&
    (aiCompleted?.payload.subjectKey !== subjectKey || aiCompleted.ts < aiStarted.ts);
  const selected = s.seasons.find((season) => season.seasonNumber === selectedSeason);
  const queued = selected ? selected.episodes.some((episode) => episode.queued) : s.queued;
  const searching = selected ? selected.episodes.some((episode) => episode.searching) : s.searching;
  const status = queued
    ? {
        icon: <Clock3 size={17} />,
        title: "Forced check queued",
        detail: "It has priority over normal backoff, pauses, and scheduled work.",
      }
    : searching
      ? {
          icon: <Loader2 size={17} className="animate-spin" />,
          title: "Sonarr search running",
          detail: "This page refreshes as the command, sync, and retry decision complete.",
        }
      : aiRunning
        ? {
            icon: <Loader2 size={17} className="animate-spin" />,
            title: "Dub oracle researching",
            detail: "The search found nothing; AI is checking whether a German dub exists.",
          }
        : {
            icon: <CheckCircle2 size={17} />,
            title: "Latest check finished",
            detail:
              selected?.history[0]?.message ??
              s.history[0]?.message ??
              "No active command remains. The retry policy shown below is now in effect.",
          };

  return (
    <Panel
      title={selectedSeason == null ? "Live series check" : `Live Season ${selectedSeason} check`}
    >
      <div className="flex items-start gap-3 p-4">
        <span className="mt-0.5 text-accent">{status.icon}</span>
        <div>
          <div className="text-[14px] font-medium text-ink">{status.title}</div>
          <p className="mt-1 text-[13px] leading-5 text-muted">{status.detail}</p>
        </div>
      </div>
    </Panel>
  );
}

function SeasonSection({
  season,
  seriesId,
  initiallyOpen = false,
}: {
  season: SeasonItem;
  seriesId: number;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const force = useForceSearch();
  const navigate = useNavigate();
  const total = season.episodes.length;

  return (
    <Panel>
      <header className="flex min-h-12 flex-wrap items-center gap-3 px-4 py-2">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-2 text-[14px] font-medium text-ink"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Season {season.seasonNumber}
          {!season.monitored ? <span className="microlabel">unmonitored</span> : null}
        </button>
        <SegmentedBar counts={season.counts} scale="season" className="max-w-[200px] flex-1" />
        <span className="ml-auto font-mono text-[12px] text-muted">{total} eps</span>
        {season.hasGermanEvidence ? (
          <span className="text-[12px] font-medium text-german">German proven · AI skipped</span>
        ) : season.releasing ? (
          <span className="text-[12px] text-nongerman">releasing · RSS-first</span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          title={`Force search season ${season.seasonNumber}`}
          onClick={(e) => {
            e.stopPropagation();
            force.mutate(
              {
                ref: { source: "sonarr", kind: "series", id: seriesId },
                body: { scope: { seasonNumber: season.seasonNumber } },
              },
              {
                onSuccess: () =>
                  navigate({
                    to: "/library/series/$seriesId",
                    params: { seriesId: String(seriesId) },
                    search: { season: season.seasonNumber, live: true },
                    replace: true,
                  }),
              },
            );
          }}
        >
          <Zap size={12} />
          Force
        </Button>
      </header>
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-4 py-2 font-mono text-[11px] text-muted">
        <span>{season.searchCount} recorded searches</span>
        <span>last {relTime(season.lastSearchAt)}</span>
        <span>
          next {season.nextEligibleAt == null ? "eligible now" : relTime(season.nextEligibleAt)}
        </span>
        {season.verdictNote ? <span className="text-aipaused">{season.verdictNote}</span> : null}
      </div>
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
              <EpisodeRow key={ep.id} ep={ep} seriesId={seriesId} />
            ))}
          </DataTable>
          {season.history.length > 0 ? (
            <div className="border-t border-line px-4 py-3">
              <div className="mb-2 text-[12px] font-medium text-ink">Season search history</div>
              <ul className="space-y-1.5">
                {season.history.slice(0, 8).map((entry, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: immutable server timeline
                    key={`${entry.at}-${index}`}
                    className="flex gap-3 text-[12px] text-muted"
                  >
                    <span className="w-32 shrink-0 font-mono text-faint">
                      {fmtDateTime(entry.at)}
                    </span>
                    <span>{entry.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function EpisodeRow({ ep, seriesId }: { ep: EpisodeItem; seriesId: number }) {
  const force = useForceSearch();
  const navigate = useNavigate();
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
            onClick={() =>
              force.mutate(
                { ref: { source: "sonarr", kind: "episode", id: ep.id } },
                {
                  onSuccess: () =>
                    navigate({
                      to: "/library/series/$seriesId",
                      params: { seriesId: String(seriesId) },
                      search: { season: ep.seasonNumber, live: true },
                      replace: true,
                    }),
                },
              )
            }
          >
            <Zap size={12} />
          </Button>
        </span>
      </Td>
    </tr>
  );
}
