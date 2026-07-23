import { useParams } from "@tanstack/react-router";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { MovieDetail } from "../../shared/api-types.js";
import { ForceControl, PauseControl, ResumeControl } from "../components/ItemActions.js";
import { EmptyState, ErrorState, Panel, Skeleton } from "../components/Shell.js";
import { StateBadge } from "../components/StateBadge.js";
import { Button } from "../components/ui/button.js";
import { fmtDate, fmtDateTime, relTime } from "../lib/format.js";
import { useInvalidateVerdict, useMovieDetail } from "../lib/queries.js";
import { cn } from "../lib/utils.js";

export function MovieDetailPage() {
  const { movieId } = useParams({ strict: false }) as { movieId: string };
  const detail = useMovieDetail(Number(movieId));

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
  const invalidate = useInvalidateVerdict();

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
              <ForceControl itemRef={itemRef} />
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
              {m.verdict ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => invalidate.mutate(m.verdict?.id ?? 0)}
                  title="Invalidate & re-check"
                >
                  <RefreshCw size={11} />
                  Re-check
                </Button>
              ) : null}
            </div>
            {m.verdict ? (
              <>
                <div className="mt-1.5 font-mono text-[13px] text-ink">
                  {m.verdict.verdict} · {m.verdict.confidence.toFixed(2)}
                </div>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] text-muted">
                  {m.verdict.evidence.slice(0, 4).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                <div className="mt-2 font-mono text-[10px] text-faint">
                  checked {relTime(m.verdict.checkedAt)} · recheck {relTime(m.verdict.recheckAfter)}
                </div>
              </>
            ) : (
              <p className="mt-2 text-[12px] text-faint">Not checked yet.</p>
            )}
          </div>
        </div>
      </Panel>

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
