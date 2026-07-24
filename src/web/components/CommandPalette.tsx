import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { ExternalLink, Pause, Play, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { SearchResult } from "../../shared/api-types.js";
import { useForceSearch, usePauseItem, useResumeItem, useTypeahead } from "../lib/queries.js";
import { StateBadge } from "./StateBadge.js";

/** Global Ctrl+K palette: search → open / Force / Pause / Resume. */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const { data, isFetching } = useTypeahead(q);
  const force = useForceSearch();
  const pause = usePauseItem();
  const resume = useResumeItem();

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const openDetail = (item: SearchResult) => {
    onOpenChange(false);
    if (item.kind === "series") {
      navigate({ to: "/library/series/$seriesId", params: { seriesId: String(item.id) } });
    } else {
      navigate({ to: "/library/movies/$movieId", params: { movieId: String(item.id) } });
    }
  };

  const refFor = (item: SearchResult) =>
    ({ source: item.source, kind: item.kind, id: item.id }) as const;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search library"
      shouldFilter={false}
      className="fixed top-[15vh] left-1/2 z-50 w-[620px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-[6px] border border-line bg-surface p-0"
    >
      <div
        className="fixed inset-0 -z-10 bg-black/60"
        aria-hidden
        onClick={() => onOpenChange(false)}
      />
      <Command.Input
        value={q}
        onValueChange={setQ}
        placeholder="Search series & movies…"
        className="h-11 w-full border-b border-line bg-transparent px-3.5 text-[14px] text-ink placeholder:text-faint outline-none"
      />
      <Command.List className="max-h-[320px] overflow-y-auto p-1">
        <Command.Empty className="py-6 text-center text-[12px] text-muted">
          {q.trim().length < 2 ? "Type to search." : isFetching ? "Searching…" : "No matches."}
        </Command.Empty>
        {(data?.items ?? []).map((item) => (
          <Command.Item
            key={`${item.source}:${item.id}`}
            value={`${item.source}:${item.id}`}
            onSelect={() => openDetail(item)}
            className="flex h-10 cursor-pointer items-center gap-2.5 rounded-[4px] px-2.5"
          >
            <span className="microlabel w-12 shrink-0">{item.kind}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
              {item.title}
              {item.year ? (
                <span className="ml-1.5 font-mono text-[11px] text-muted">{item.year}</span>
              ) : null}
            </span>
            <StateBadge state={item.state} />
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                title="Force search now"
                className="cursor-pointer rounded p-1 text-muted hover:bg-bg hover:text-accent"
                onClick={(e) => {
                  e.stopPropagation();
                  force.mutate(
                    { ref: refFor(item) },
                    {
                      onSuccess: () => {
                        onOpenChange(false);
                        if (item.kind === "series") {
                          navigate({
                            to: "/library/series/$seriesId",
                            params: { seriesId: String(item.id) },
                            search: { live: true },
                          });
                        } else {
                          navigate({
                            to: "/library/movies/$movieId",
                            params: { movieId: String(item.id) },
                            search: { live: true },
                          });
                        }
                      },
                    },
                  );
                }}
              >
                <Zap size={13} />
              </button>
              <button
                type="button"
                title="Pause"
                className="cursor-pointer rounded p-1 text-muted hover:bg-bg hover:text-ink"
                onClick={(e) => {
                  e.stopPropagation();
                  pause.mutate({ ref: refFor(item), body: {} });
                  onOpenChange(false);
                }}
              >
                <Pause size={13} />
              </button>
              <button
                type="button"
                title="Resume"
                className="cursor-pointer rounded p-1 text-muted hover:bg-bg hover:text-ink"
                onClick={(e) => {
                  e.stopPropagation();
                  resume.mutate({ ref: refFor(item) });
                  onOpenChange(false);
                }}
              >
                <Play size={13} />
              </button>
              <button
                type="button"
                title="Open detail"
                className="cursor-pointer rounded p-1 text-muted hover:bg-bg hover:text-ink"
                onClick={(e) => {
                  e.stopPropagation();
                  openDetail(item);
                }}
              >
                <ExternalLink size={13} />
              </button>
            </span>
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
