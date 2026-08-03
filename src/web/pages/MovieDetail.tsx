import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { CheckCircle2, Clock3, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { MovieDetail } from "../../shared/api-types.js";
import { DubVerdictSummary } from "../components/DubVerdictSummary.js";
import { ForceControl, PauseControl, ResumeControl } from "../components/ItemActions.js";
import { EmptyState, ErrorState, Panel, Skeleton } from "../components/Shell.js";
import { StateBadge } from "../components/StateBadge.js";
import { Button } from "../components/ui/button.js";
import { useLatestEvent } from "../lib/events.js";
import { fmtDate, fmtDateTime, relTime } from "../lib/format.js";
import { useMovieDetail, useRecheckSubject } from "../lib/queries.js";
import { cn } from "../lib/utils.js";

export function MovieDetailPage() {
  const { movieId } = useParams({ strict: false }) as { movieId: string };
  const search = useSearch({ strict: false }) as { live?: boolean };
  const detail = useMovieDetail(Number(movieId), search.live === true);

  if (detail.isPending) {
    return (
      <div className="mx-auto max-w-[1100px] space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return <ErrorState message="Could not load this movie." />;
  }
  return <MovieDetailView m={detail.data} />;
}

function MovieDetailView({ m }: { m: MovieDetail }) {
  const itemRef = { source: "radarr", kind: "movie", id: m.id } as const;
  const recheck = useRecheckSubject();
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
      <Panel className="p-4">
        <div className="flex gap-4">
          {m.posterUrl ? (
            <img
              src={m.posterUrl}
              alt=""
              className="h-36 w-24 shrink-0 rounded-[4px] border border-line object-cover"
            />
          ) : (
            <div className="h-36 w-24 shrink-0 rounded-[4px] border border-line bg-raised" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[17px] font-semibold tracking-tight text-ink">{m.title}</h1>
              {m.year ? <span className="font-mono text-[12px] text-muted">{m.year}</span> : null}
              <StateBadge
                state={m.pause.paused ? "user_paused" : m.state}
                searching={m.searching}
              />
              {m.arrUrl ? (
                <a
                  href={m.arrUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted hover:text-ink"
                  title="Open in Radarr"
                >
                  <ExternalLink size={13} />
                </a>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-muted">
              {m.quality ? <span>{m.quality}</span> : null}
              {m.originalLanguage ? <span>original {m.originalLanguage}</span> : null}
              {m.status ? <span>{m.status}</span> : null}
              <span>
                searches {m.searchCount} · tier {m.tier}
              </span>
              <span>next {relTime(m.nextEligibleAt)}</span>
              {m.path ? <span className="truncate">{m.path}</span> : null}
            </div>
            <div className="mt-2 flex gap-1">
              {m.audioLanguages.map((lang) => (
                <span
                  key={lang}
                  className={cn(
                    "rounded-[3px] border px-1.5 py-px font-mono text-[10px] uppercase",
                    lang.toLowerCase().startsWith("ger")
                      ? "border-german/50 text-german"
                      : "border-line text-muted",
                  )}
                >
                  {lang}
                </span>
              ))}
            </div>
            {m.pause.paused ? (
              <p className="mt-2 text-[12px] text-userpaused">
                Paused {m.pause.until ? `until ${fmtDate(m.pause.until)}` : "indefinitely"}
                {m.pause.note ? ` — ${m.pause.note}` : ""}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ForceControl
                itemRef={itemRef}
                onForced={() =>
                  navigate({
                    to: "/library/movies/$movieId",
                    params: { movieId: String(m.id) },
                    search: { live: true },
                    replace: true,
                  })
                }
              />
              {m.pause.paused || m.state === "ai_paused" ? (
                <ResumeControl
                  itemRef={itemRef}
                  aiPaused={m.state === "ai_paused"}
                  verdict={m.verdict}
                />
              ) : (
                <PauseControl itemRef={itemRef} />
              )}
            </div>
          </div>
          <div className="hidden w-[260px] shrink-0 rounded-[6px] border border-line bg-bg p-3 md:block">
            <div className="flex items-center justify-between">
              <span className="microlabel">AI dub verdict</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={recheck.isPending}
                onClick={() => recheck.mutate(`radarr:${m.id}`)}
                title="Run a human-forced AI check now"
              >
                <RefreshCw size={11} />
                Check now
              </Button>
            </div>
            {m.verdict ? (
              <DubVerdictSummary verdict={m.verdict} />
            ) : (
              <p className="mt-2 text-[12px] text-faint">Not checked yet.</p>
            )}
          </div>
        </div>
      </Panel>

      <MovieLiveCheck m={m} />

      <Panel title="History">
        {m.history.length === 0 ? (
          <EmptyState message="No history yet for this movie." />
        ) : (
          <ul className="p-3">
            {m.history.map((h, i) => (
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

function MovieLiveCheck({ m }: { m: MovieDetail }) {
  const aiStarted = useLatestEvent("ai.check.started");
  const aiCompleted = useLatestEvent("ai.check.completed");
  const subjectKey = `radarr:${m.id}`;
  const aiRunning =
    aiStarted?.payload.subjectKey === subjectKey &&
    (aiCompleted?.payload.subjectKey !== subjectKey || aiCompleted.ts < aiStarted.ts);
  const status = m.queued
    ? {
        icon: <Clock3 size={17} />,
        title: "Forced movie check queued",
        detail: "It bypasses the normal one-month retry floor and every pause.",
      }
    : m.searching
      ? {
          icon: <Loader2 size={17} className="animate-spin" />,
          title: "Radarr search running",
          detail: "The result and the next retry decision will appear here automatically.",
        }
      : aiRunning
        ? {
            icon: <Loader2 size={17} className="animate-spin" />,
            title: "Dub oracle researching",
            detail: "AI is checking whether a German release exists before the next long wait.",
          }
        : {
            icon: <CheckCircle2 size={17} />,
            title: "Latest check finished",
            detail:
              m.history[0]?.message ??
              "No active command remains. The movie retry policy is now in effect.",
          };
  return (
    <Panel title="Live movie check">
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
