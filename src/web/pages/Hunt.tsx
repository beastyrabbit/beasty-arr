import { useNavigate } from "@tanstack/react-router";
import { ArrowUpToLine, ChevronDown, ChevronRight, Play, X, Zap } from "lucide-react";
import { useState } from "react";
import type { SearchResult } from "../../shared/api-types.js";
import { LedDot } from "../components/LedDot.js";
import { DataTable, EmptyState, Panel, SkeletonRows, Td, Th } from "../components/Shell.js";
import { StateBadge } from "../components/StateBadge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { fmtDate, relTime } from "../lib/format.js";
import {
  useEngineAction,
  useForceSearch,
  useHuntPaused,
  useHuntQueue,
  useHuntStatus,
  useQueueBump,
  useQueueRemove,
  useResumeItem,
  useTypeahead,
} from "../lib/queries.js";
import { STATE_META } from "../lib/states.js";

const REASON_STYLES: Record<string, { label: string; color: string }> = {
  forced: { label: "FORCED", color: "#f0a63a" },
  scheduled: { label: "SCHEDULED", color: "#94a3b8" },
  retry: { label: "RETRY", color: "#7dd3fc" },
};

export function HuntPage() {
  const status = useHuntStatus();
  const queue = useHuntQueue();
  const engine = useEngineAction();

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
      <ForceBar />

      {/* now hunting */}
      <Panel
        title="Now hunting"
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => engine.mutate("cycle")}>
              Run cycle
            </Button>
            {status.data?.engine === "paused" ? (
              <Button variant="primary" size="sm" onClick={() => engine.mutate("resume")}>
                Resume engine
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => engine.mutate("pause")}>
                Pause engine
              </Button>
            )}
          </div>
        }
      >
        <div className="flex items-center gap-3 p-3">
          {status.data?.current ? (
            <>
              <LedDot state="live" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-ink">{status.data.current.label}</div>
                <div className="font-mono text-[11px] text-muted">
                  {status.data.current.commandName} · started{" "}
                  {relTime(status.data.current.startedAt)}
                  {status.data.current.dryRun ? " · dry" : ""}
                </div>
              </div>
              <span className="microlabel">{status.data.current.status}</span>
            </>
          ) : (
            <>
              <LedDot state={status.data?.engine === "paused" ? "down" : "off"} />
              <span className="text-[12px] text-muted">
                {status.data?.engine === "paused"
                  ? "Engine paused."
                  : `Idle — next tick ${relTime(status.data?.nextTickAt ?? null)}`}
              </span>
              {status.data ? (
                <span className="ml-auto font-mono text-[11px] text-faint">
                  queue gate S:{status.data.queueGate.sonarr.size} R:
                  {status.data.queueGate.radarr.size} / {status.data.queueGate.threshold}
                </span>
              ) : null}
            </>
          )}
        </div>
      </Panel>

      {/* up next */}
      <Panel title="Up next">
        <DataTable
          head={
            <>
              <Th className="w-10">#</Th>
              <Th>Title / scope</Th>
              <Th>Reason</Th>
              <Th>Est. queries</Th>
              <Th className="text-right">Actions</Th>
            </>
          }
        >
          {queue.isPending ? (
            <SkeletonRows rows={5} cols={5} />
          ) : queue.data && queue.data.items.length > 0 ? (
            queue.data.items.map((item) => <QueueRow key={item.id} item={item} />)
          ) : (
            <tr>
              <td colSpan={5}>
                <EmptyState
                  message="Queue is empty."
                  hint="Scheduled candidates appear here each tick."
                />
              </td>
            </tr>
          )}
        </DataTable>
      </Panel>

      <PausedSections />
    </div>
  );
}

function ForceBar() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [season, setSeason] = useState("");
  const typeahead = useTypeahead(q);
  const force = useForceSearch();

  const dispatch = () => {
    if (!selected) return;
    const seasonNumber = season === "" ? undefined : Number(season);
    const target = selected;
    force.mutate(
      {
        ref: { source: target.source, kind: target.kind, id: target.id },
        body: seasonNumber !== undefined ? { scope: { seasonNumber } } : {},
      },
      {
        onSuccess: () => {
          if (target.kind === "series") {
            void navigate({
              to: "/library/series/$seriesId",
              params: { seriesId: String(target.id) },
              search: { season: seasonNumber, live: true },
            });
          } else {
            void navigate({
              to: "/library/movies/$movieId",
              params: { movieId: String(target.id) },
              search: { live: true },
            });
          }
        },
      },
    );
    setSelected(null);
    setQ("");
    setSeason("");
  };

  return (
    <Panel className="p-4">
      <div className="microlabel mb-2">Force a hunt</div>
      <div className="relative">
        {selected ? (
          <div className="flex h-9 items-center gap-2 rounded-[6px] border border-accent/60 bg-bg px-3">
            <span className="microlabel">{selected.kind}</span>
            <span className="flex-1 truncate text-[13px] text-ink">
              {selected.title}
              {selected.year ? (
                <span className="ml-1.5 font-mono text-[11px] text-muted">{selected.year}</span>
              ) : null}
            </span>
            <StateBadge state={selected.state} />
            <button
              type="button"
              className="cursor-pointer text-muted hover:text-ink"
              onClick={() => setSelected(null)}
              title="Clear"
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search series or movies to force…"
              className="h-9 text-[13px]"
            />
            {q.trim().length >= 2 && typeahead.data ? (
              <div className="absolute top-10 right-0 left-0 z-20 max-h-[260px] overflow-y-auto rounded-[6px] border border-line bg-surface p-1">
                {typeahead.data.items.length === 0 ? (
                  <div className="px-2 py-3 text-center text-[12px] text-faint">No matches.</div>
                ) : (
                  typeahead.data.items.map((item) => (
                    <button
                      key={`${item.source}:${item.id}`}
                      type="button"
                      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[4px] px-2 text-left hover:bg-raised"
                      onClick={() => setSelected(item)}
                    >
                      <span className="microlabel w-12">{item.kind}</span>
                      <span className="flex-1 truncate text-[13px] text-ink">{item.title}</span>
                      <StateBadge state={item.state} />
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
      {/* scope row */}
      <div className="mt-2 flex items-center gap-2">
        {selected?.kind === "series" ? (
          <Input
            value={season}
            onChange={(e) => setSeason(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="Season # (blank = whole series)"
            className="w-[220px] font-mono"
          />
        ) : null}
        <Button
          variant="primary"
          size="lg"
          disabled={!selected || force.isPending}
          onClick={dispatch}
        >
          <Zap size={14} />
          Force now
        </Button>
        <span className="text-[11px] text-faint">
          Jumps to queue position 1 with a{" "}
          <span style={{ color: STATE_META.non_german.color }}>FORCED</span> tag. Ctrl+K works
          anywhere.
        </span>
      </div>
    </Panel>
  );
}

function QueueRow({
  item,
}: {
  item: {
    id: number;
    position: number;
    title: string;
    scopeLabel: string;
    reason: string;
    estimatedQueries: number | null;
  };
}) {
  const bump = useQueueBump();
  const remove = useQueueRemove();
  const reason = REASON_STYLES[item.reason] ?? REASON_STYLES.scheduled;
  return (
    <tr className="h-8 border-b border-line last:border-b-0">
      <Td>
        <span className="font-mono text-[11px] text-muted">{item.position}</span>
      </Td>
      <Td>
        <span className="text-[13px] text-ink">{item.title}</span>
        <span className="ml-2 font-mono text-[11px] text-muted">{item.scopeLabel}</span>
      </Td>
      <Td>
        <span
          className="rounded-[4px] border px-1.5 py-px text-[10px] font-semibold tracking-[0.08em]"
          style={{
            color: reason.color,
            borderColor: `color-mix(in srgb, ${reason.color} 55%, transparent)`,
          }}
        >
          {reason.label}
        </span>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{item.estimatedQueries ?? "—"}</span>
      </Td>
      <Td>
        <span className="flex items-center justify-end gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            title="Bump to top"
            onClick={() => bump.mutate(item.id)}
          >
            <ArrowUpToLine size={13} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Remove from queue"
            onClick={() => remove.mutate(item.id)}
          >
            <X size={13} />
          </Button>
        </span>
      </Td>
    </tr>
  );
}

function PausedSections() {
  const paused = useHuntPaused();
  const resume = useResumeItem();
  const [openPaused, setOpenPaused] = useState(false);
  const [openDormant, setOpenDormant] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const dormant = paused.data?.aiDormant ?? [];
  const userPaused = paused.data?.userPaused ?? [];

  const keyOf = (d: { source: string; kind: string; targetId: number }) =>
    `${d.source}:${d.kind}:${d.targetId}`;

  const resumeSelected = () => {
    for (const d of dormant) {
      if (selected.has(keyOf(d))) {
        resume.mutate({
          ref: { source: d.source, kind: d.kind, id: d.targetId },
          body: { overrideAi: true },
        });
      }
    }
    setSelected(new Set());
  };

  return (
    <>
      <Panel>
        <button
          type="button"
          className="flex h-9 w-full cursor-pointer items-center gap-2 px-3 text-left"
          onClick={() => setOpenPaused((o) => !o)}
        >
          {openPaused ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="microlabel">Manually paused</span>
          <span className="font-mono text-[11px] text-muted">{userPaused.length}</span>
        </button>
        {openPaused ? (
          <div className="border-t border-line">
            {userPaused.length === 0 ? (
              <EmptyState message="Nothing manually paused." />
            ) : (
              <DataTable
                head={
                  <>
                    <Th>Title</Th>
                    <Th>Note</Th>
                    <Th>Since</Th>
                    <Th>Until</Th>
                    <Th className="text-right">Resume</Th>
                  </>
                }
              >
                {userPaused.map((p) => (
                  <tr key={keyOf(p)} className="h-8 border-b border-line last:border-b-0">
                    <Td>
                      <span className="text-ink">{p.title}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted">{p.label}</span>
                    </Td>
                    <Td>
                      <span className="text-[12px] text-muted">{p.note ?? "—"}</span>
                    </Td>
                    <Td>
                      <span className="font-mono text-[11px] text-muted">{fmtDate(p.since)}</span>
                    </Td>
                    <Td>
                      <span className="font-mono text-[11px] text-muted">
                        {p.until ? fmtDate(p.until) : "indefinite"}
                      </span>
                    </Td>
                    <Td>
                      <span className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Resume"
                          onClick={() =>
                            resume.mutate({
                              ref: { source: p.source, kind: p.kind, id: p.targetId },
                            })
                          }
                        >
                          <Play size={13} />
                        </Button>
                      </span>
                    </Td>
                  </tr>
                ))}
              </DataTable>
            )}
          </div>
        ) : null}
      </Panel>

      <Panel>
        <div className="flex h-9 items-center gap-2 px-3">
          <button
            type="button"
            className="flex flex-1 cursor-pointer items-center gap-2 text-left"
            onClick={() => setOpenDormant((o) => !o)}
          >
            {openDormant ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className="microlabel" style={{ color: STATE_META.ai_paused.color }}>
              AI-dormant
            </span>
            <span className="font-mono text-[11px] text-muted">{dormant.length}</span>
          </button>
          {openDormant && selected.size > 0 ? (
            <Button variant="outline" size="sm" onClick={resumeSelected}>
              Override AI & resume {selected.size} selected
            </Button>
          ) : null}
        </div>
        {openDormant ? (
          <div className="border-t border-line">
            {dormant.length === 0 ? (
              <EmptyState message="No AI-dormant items." />
            ) : (
              <DataTable
                head={
                  <>
                    <Th className="w-8" />
                    <Th>Title</Th>
                    <Th>Confidence</Th>
                    <Th>Wake date</Th>
                    <Th className="text-right">Resume</Th>
                  </>
                }
              >
                {dormant.map((d) => {
                  const k = keyOf(d);
                  return (
                    <tr key={k} className="h-8 border-b border-line last:border-b-0">
                      <Td>
                        <input
                          type="checkbox"
                          className="accent-[#f0a63a]"
                          checked={selected.has(k)}
                          onChange={(e) => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(k);
                              else next.delete(k);
                              return next;
                            });
                          }}
                        />
                      </Td>
                      <Td>
                        <span className="text-ink">{d.title}</span>
                        <span
                          className="ml-2 text-[11px]"
                          style={{ color: STATE_META.ai_paused.color }}
                          title={d.evidence.join("\n")}
                        >
                          {d.verdict}
                        </span>
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] text-muted">
                          {d.confidence.toFixed(2)}
                        </span>
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] text-muted">
                          {fmtDate(d.wakeAt)}
                        </span>
                      </Td>
                      <Td>
                        <span className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Override AI & resume"
                            onClick={() =>
                              resume.mutate({
                                ref: { source: d.source, kind: d.kind, id: d.targetId },
                                body: { overrideAi: true },
                              })
                            }
                          >
                            <Play size={12} />
                            Override
                          </Button>
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </DataTable>
            )}
          </div>
        ) : null}
      </Panel>
    </>
  );
}
