import { Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  OctagonX,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  FixerAnalysisDto,
  FixerApplyRequest,
  FixerQueueItemDto,
} from "../../shared/api-types.js";
import type {
  ProposalAction,
  QueueRemovalOptions,
  ResolverEvent,
} from "../../shared/fixer-types.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { EmptyState, Panel, Skeleton } from "../components/Shell.js";
import { Button } from "../components/ui/button.js";
import { Switch } from "../components/ui/switch.js";
import { Tip } from "../components/ui/tooltip.js";
import { useSseEvent } from "../lib/events.js";
import { uniqueQueueItems, waitsForReview } from "../lib/fixer-queue.js";
import { fmtBytes, fmtTime, relTime } from "../lib/format.js";
import {
  useConfig,
  useFixerAnalysis,
  useFixerApply,
  useFixerBulk,
  useFixerBulkStatus,
  useFixerCancel,
  useFixerIgnore,
  useFixerQueue,
  useFixerRefresh,
  useFixerRemove,
  useUpdateConfig,
} from "../lib/queries.js";
import { STATE_META } from "../lib/states.js";
import { cn } from "../lib/utils.js";

type ItemKey = string;
const keyOf = (item: { service: string; id: number }): ItemKey => `${item.service}:${item.id}`;

function removalDescription(options: QueueRemovalOptions | undefined): string {
  if (!options) return "The proposal is missing its queue removal options and cannot be applied.";
  const download = options.removeFromClient
    ? "remove the download from the client"
    : "leave the download in the client";
  const blocklist = options.blocklist
    ? "blocklist this exact release"
    : "do not blocklist the release";
  const search = options.skipRedownload
    ? "do not trigger a replacement search"
    : "allow the arr to search for a replacement";
  return `This will ${download}, ${blocklist}, and ${search}.`;
}

function RemovalOptionsSummary({
  action,
  options,
}: {
  action: ProposalAction;
  options: QueueRemovalOptions | undefined;
}) {
  if (action !== "remove_queue_item") return null;
  if (!options) {
    return (
      <div className="rounded-[6px] border border-missing/40 bg-missing/8 p-2 text-[12px] text-missing">
        Queue removal options are missing. This proposal cannot be applied.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-[6px] border border-line bg-bg p-2 text-[12px]">
      <span className="text-muted">Remove download</span>
      <span className="font-mono text-ink">{options.removeFromClient ? "yes" : "no"}</span>
      <span className="text-muted">Blocklist exact release</span>
      <span className="font-mono text-ink">{options.blocklist ? "yes" : "no"}</span>
      <span className="text-muted">Replacement search</span>
      <span className="font-mono text-ink">{options.skipRedownload ? "no" : "yes"}</span>
      <span className="text-muted">Change category</span>
      <span className="font-mono text-ink">{options.changeCategory ? "yes" : "no"}</span>
    </div>
  );
}

function ProposalApplyButton({
  action,
  validationOk,
  selectedCount,
  removalOptions,
  busy,
  onClick,
}: {
  action: ProposalAction;
  validationOk: boolean;
  selectedCount: number;
  removalOptions: QueueRemovalOptions | undefined;
  busy: boolean;
  onClick: () => void;
}) {
  if (action === "import_candidates") {
    return (
      <Button
        variant="primary"
        disabled={!validationOk || selectedCount === 0 || busy}
        onClick={onClick}
      >
        Apply import ({selectedCount})
      </Button>
    );
  }
  if (action === "remove_queue_item") {
    return (
      <Button
        variant="primary"
        disabled={!validationOk || !removalOptions || busy}
        onClick={onClick}
      >
        Apply proposed removal
      </Button>
    );
  }
  return null;
}

function proposalApplyDialog(
  action: ProposalAction,
  removalOptions: QueueRemovalOptions | undefined,
  selectedIds: Set<string>,
  itemTitle: string,
): {
  title: string;
  description: string;
  confirmLabel: string;
  danger: boolean;
  body: FixerApplyRequest;
} {
  if (action === "remove_queue_item") {
    return {
      title: "Apply proposed removal",
      description: removalDescription(removalOptions),
      confirmLabel: "Apply proposed removal",
      danger: true,
      body: {},
    };
  }
  return {
    title: "Apply import",
    description: `Import ${selectedIds.size} file(s) for “${itemTitle}”.`,
    confirmLabel: "Apply import",
    danger: false,
    body: { candidateIds: [...selectedIds] },
  };
}

export function FixerPage() {
  const queue = useFixerQueue();
  const refresh = useFixerRefresh();
  const bulk = useFixerBulk();
  const bulkStatus = useFixerBulkStatus();
  const config = useConfig();
  const updateConfig = useUpdateConfig();
  const [selected, setSelected] = useState<Set<ItemKey>>(new Set());
  const [activeKey, setActiveKey] = useState<ItemKey | null>(null);

  const dryRun = config.data?.settings.dryRun ?? true;
  const autoRun = config.data?.settings.fixerAutoRun ?? false;
  const autoApply = config.data?.settings.fixerAutoApply ?? false;
  const items = useMemo(() => uniqueQueueItems(queue.data?.items ?? []), [queue.data?.items]);
  const selectedItems = items.filter((item) => selected.has(keyOf(item)));
  const pendingItems = items.filter((item) => item.analysisState === null);
  const activeItem = items.find((i) => keyOf(i) === activeKey) ?? null;
  const activeAnalyses = bulkStatus.data?.activeItemIds.length ?? 0;
  const waitingReviews = items.filter(waitsForReview).length;

  const groups = useMemo(() => {
    const map = new Map<string, FixerQueueItemDto[]>();
    for (const item of items) {
      const list = map.get(item.issueType) ?? [];
      list.push(item);
      map.set(item.issueType, list);
    }
    return [...map.entries()];
  }, [items]);

  const analyzeItems = (list: FixerQueueItemDto[]) => {
    if (list.length === 0) return;
    bulk.mutate({
      action: "start",
      body: {
        targets: list.map((item) => ({ service: item.service, queueItemId: item.id })),
      },
    });
  };

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[15px] font-semibold text-ink">Fixer</h1>
        <Link
          to="/fixer/history"
          className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          History
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw size={12} className={refresh.isPending ? "animate-spin" : undefined} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={selectedItems.length === 0 || bulkStatus.data?.running}
            onClick={() => {
              analyzeItems(selectedItems);
              setSelected(new Set());
            }}
          >
            <Sparkles size={12} />
            Analyze selected
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pendingItems.length === 0 || bulkStatus.data?.running}
            onClick={() => bulk.mutate({ action: "start", body: { skipAnalyzed: true } })}
          >
            <Play size={12} />
            Run all
          </Button>
          <span className="font-mono text-[10px] text-faint">
            {activeAnalyses} running · {waitingReviews} waiting review
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!bulkStatus.data?.running}
            onClick={() => bulk.mutate({ action: "cancel" })}
          >
            <OctagonX size={12} />
            Stop all
          </Button>
          <Tip content="Automatically analyze each new stuck download once. Existing proposals waiting for review are skipped.">
            <span className="flex items-center gap-2 text-[12px] text-muted">
              auto-run
              <Switch
                checked={autoRun}
                disabled={updateConfig.isPending}
                onCheckedChange={(value) =>
                  updateConfig.mutate(
                    { fixerAutoRun: value },
                    {
                      onSuccess: () => {
                        if (value && !bulkStatus.data?.running) {
                          bulk.mutate({ action: "start", body: { skipAnalyzed: true } });
                        }
                      },
                    },
                  )
                }
              />
            </span>
          </Tip>
          <Tip
            content={
              dryRun
                ? "Auto-apply is disabled while dry-run is on."
                : "Automatically apply proposals above the confidence gate."
            }
          >
            <span className="flex items-center gap-2 text-[12px] text-muted">
              auto-apply
              <Switch
                checked={autoApply && !dryRun}
                disabled={dryRun || updateConfig.isPending}
                onCheckedChange={(v) => updateConfig.mutate({ fixerAutoApply: v })}
              />
            </span>
          </Tip>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(420px,5fr)_minmax(420px,6fr)]">
        {/* left: stuck queue */}
        <Panel>
          {queue.isPending ? (
            <div className="space-y-2 p-3">
              <Skeleton className="w-full" />
              <Skeleton className="w-3/4" />
              <Skeleton className="w-5/6" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              message="Nothing stuck. The import queues are clean."
              hint="Stuck items from Sonarr/Radarr appear here."
            />
          ) : (
            groups.map(([issueType, groupItems]) => (
              <div key={issueType}>
                <div className="flex h-8 items-center gap-2 border-b border-line bg-raised/50 px-3">
                  <input
                    type="checkbox"
                    aria-label={`Select all ${issueType} items`}
                    className="accent-[#f0a63a]"
                    checked={groupItems.every((item) => selected.has(keyOf(item)))}
                    onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const item of groupItems) {
                          const key = keyOf(item);
                          if (event.target.checked) next.add(key);
                          else next.delete(key);
                        }
                        return next;
                      });
                    }}
                  />
                  <span className="microlabel">{issueType}</span>
                  <span className="font-mono text-[11px] text-muted">{groupItems.length}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={
                      bulkStatus.data?.running ||
                      groupItems.every(
                        (item) => waitsForReview(item) || item.analysisState === "analyzing",
                      )
                    }
                    onClick={() =>
                      analyzeItems(
                        groupItems.filter(
                          (item) => !waitsForReview(item) && item.analysisState !== "analyzing",
                        ),
                      )
                    }
                  >
                    Analyze all
                  </Button>
                </div>
                {groupItems.map((item) => {
                  const k = keyOf(item);
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: row select + inner checkbox
                    // biome-ignore lint/a11y/useKeyWithClickEvents: row select duplicated by checkbox
                    <div
                      key={k}
                      onClick={() => setActiveKey(k)}
                      className={cn(
                        "flex h-8 cursor-pointer items-center gap-2 border-b border-line px-3 last:border-b-0",
                        activeKey === k ? "bg-raised" : "hover:bg-raised/50",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-[#f0a63a]"
                        checked={selected.has(k)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(k);
                            else next.delete(k);
                            return next;
                          });
                        }}
                      />
                      <span className="font-mono text-[10px] text-faint" title={item.service}>
                        {item.service === "sonarr" ? "S" : "R"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                        {item.title}
                      </span>
                      <span className="font-mono text-[10px] text-faint">
                        {item.addedAt ? relTime(Date.parse(item.addedAt)) : "—"}
                      </span>
                      <AnalysisStateBadge item={item} />
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </Panel>

        {/* right: review panel */}
        <ReviewPanel item={activeItem} dryRun={dryRun} />
      </div>
    </div>
  );
}

function AnalysisStateBadge({ item }: { item: FixerQueueItemDto }) {
  const state = item.analysisState;
  if (state === "analyzing") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-searching">
        <Loader2 size={11} className="animate-spin" /> ANALYZING
      </span>
    );
  }
  const style: Record<string, { label: string; color: string }> = {
    queued: { label: "QUEUED", color: "#94a3b8" },
    proposal: {
      label: item.confidence != null ? item.confidence.toFixed(2) : "PROPOSAL",
      color: STATE_META.german.color,
    },
    needs_review: { label: "NEEDS REVIEW", color: "#fbbf24" },
    error: { label: "ERROR", color: STATE_META.missing.color },
    applied: { label: "APPLIED", color: STATE_META.german.color },
    cancelled: { label: "CANCELLED", color: "#5c6370" },
  };
  const meta = state ? style[state] : undefined;
  if (!meta) return <span className="text-[10px] text-faint">—</span>;
  return (
    <span
      className="rounded-[4px] border px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.05em]"
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 55%, transparent)`,
      }}
    >
      {meta.label}
    </span>
  );
}

function ReviewPanel({ item, dryRun }: { item: FixerQueueItemDto | null; dryRun: boolean }) {
  const analysis = useFixerAnalysis(item?.analysisId ?? null);
  const cancel = useFixerCancel();
  const [liveEvents, setLiveEvents] = useState<Record<string, ResolverEvent[]>>({});

  useSseEvent("fixer.analysis.progress", (e) => {
    setLiveEvents((prev) => {
      const list = prev[e.payload.analysisId] ?? [];
      return { ...prev, [e.payload.analysisId]: [...list, e.payload.event].slice(-200) };
    });
  });

  if (!item) {
    return (
      <Panel>
        <EmptyState
          message="Select a stuck item to review."
          hint="Analyses stream here live; proposals wait for your call."
        />
      </Panel>
    );
  }

  const a = analysis.data;
  const running = item.analysisState === "analyzing" || a?.status === "running";
  const streamed = item.analysisId ? (liveEvents[item.analysisId] ?? []) : [];
  const events = [...(a?.events ?? []), ...streamed];

  if (running || (!a && item.analysisId && analysis.isPending)) {
    return (
      <Panel title={item.title}>
        <div className="p-3">
          <div className="flex items-center gap-2 text-[12px] text-searching">
            <Loader2 size={13} className="animate-spin" />
            Analyzing…
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => cancel.mutate({ service: item.service, id: item.id })}
            >
              Cancel
            </Button>
          </div>
          <div className="mt-2 max-h-[420px] overflow-y-auto rounded-[6px] border border-line bg-bg p-2 font-mono text-[11px]">
            {events.length === 0 ? (
              <span className="text-faint">Waiting for resolver output…</span>
            ) : (
              events.map((ev, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream, entries never reorder
                <div key={`${ev.timestamp}-${i}`} className="flex gap-2">
                  <span className="shrink-0 text-faint">{fmtTime(Date.parse(ev.timestamp))}</span>
                  <span
                    className={cn(
                      "shrink-0 uppercase",
                      ev.type === "error"
                        ? "text-missing"
                        : ev.type === "warning"
                          ? "text-nongerman"
                          : "text-faint",
                    )}
                  >
                    {ev.type}
                  </span>
                  <span className="text-muted">{ev.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </Panel>
    );
  }

  if (!a?.proposal) {
    return (
      <Panel title={item.title}>
        <EmptyState
          message={a?.error ? `Analysis failed: ${a.error}` : "Not analyzed yet."}
          hint='Hit "Analyze" on the left to start.'
        />
      </Panel>
    );
  }

  return <ProposalCard item={item} analysis={a} dryRun={dryRun} />;
}

function ProposalCard({
  item,
  analysis,
  dryRun,
}: {
  item: FixerQueueItemDto;
  analysis: FixerAnalysisDto;
  dryRun: boolean;
}) {
  const config = useConfig();
  const apply = useFixerApply();
  const remove = useFixerRemove();
  const ignore = useFixerIgnore();
  const proposal = analysis.proposal;
  const threshold = config.data?.settings.fixerAutoImportConfidence ?? 0.8;
  const [includes, setIncludes] = useState<Set<string> | null>(null);
  const [confirm, setConfirm] = useState<"apply" | "ignore" | "remove" | "blocklist" | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  if (!proposal) return null;
  const removalOptions = proposal.queueRemovalOptions;
  const validationOk = analysis.validation?.ok ?? true;
  const selectedIds =
    includes ?? new Set(proposal.selectedCandidateIds.filter((id) => id.length > 0));
  const candidates = analysis.candidates ?? [];
  const selectedCandidates = candidates.filter((c) => proposal.selectedCandidateIds.includes(c.id));
  const selectedImports = new Map(
    proposal.selectedImports.map((selectedImport) => [selectedImport.candidateId, selectedImport]),
  );
  const applyDialog = proposalApplyDialog(proposal.action, removalOptions, selectedIds, item.title);

  const verdict =
    proposal.action === "remove_queue_item"
      ? { label: "Would remove from queue", color: STATE_META.missing.color }
      : !validationOk
        ? { label: "Blocked by validation", color: STATE_META.missing.color }
        : proposal.action === "import_candidates" && proposal.confidence >= threshold
          ? {
              label: dryRun ? "Would auto-import (dry-run)" : "Would auto-import",
              color: STATE_META.german.color,
            }
          : { label: "Below auto threshold — review", color: STATE_META.non_german.color };

  const toggleInclude = (id: string, checked: boolean) => {
    setIncludes(() => {
      const next = new Set(selectedIds);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <Panel title={analysis.itemLabel}>
      <div className="flex flex-col gap-3 p-3">
        {/* verdict banner */}
        <div
          className="flex items-center gap-2 rounded-[6px] border px-3 py-2 text-[13px] font-medium"
          style={{
            color: verdict.color,
            borderColor: `color-mix(in srgb, ${verdict.color} 50%, transparent)`,
            background: `color-mix(in srgb, ${verdict.color} 8%, transparent)`,
          }}
        >
          {verdict.label}
          <span className="ml-auto font-mono text-[12px]">{proposal.action}</span>
        </div>

        {/* confidence meter with threshold tick */}
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="microlabel">Confidence</span>
            <span className="font-mono text-[13px] text-ink">{proposal.confidence.toFixed(2)}</span>
          </div>
          <div className="relative h-2 overflow-hidden rounded-[3px] bg-raised">
            <div
              className="absolute inset-y-0 left-0"
              style={{
                width: `${Math.min(100, proposal.confidence * 100)}%`,
                background:
                  proposal.confidence >= threshold
                    ? STATE_META.german.color
                    : STATE_META.non_german.color,
              }}
            />
            <Tip content={`auto-import gate ${threshold.toFixed(2)}`}>
              <div
                className="absolute inset-y-0 w-px cursor-help bg-ink"
                style={{ left: `${threshold * 100}%` }}
              />
            </Tip>
          </div>
        </div>

        <p className="text-[12px] text-muted">{proposal.reason}</p>

        <RemovalOptionsSummary action={proposal.action} options={removalOptions} />

        {/* evidence + warnings */}
        {proposal.evidence.length > 0 ? (
          <div>
            <div className="microlabel mb-1">Evidence</div>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-muted">
              {proposal.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {proposal.warnings.length > 0 ? (
          <div className="rounded-[6px] border border-nongerman/40 bg-nongerman/8 p-2">
            <div className="microlabel mb-1 text-nongerman">Warnings</div>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-nongerman">
              {proposal.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {analysis.validation && analysis.validation.issues.length > 0 ? (
          <div className="rounded-[6px] border border-missing/40 bg-missing/8 p-2">
            <div className="microlabel mb-1 text-missing">Validation</div>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-missing">
              {analysis.validation.issues.map((issue) => (
                <li key={`${issue.severity}:${issue.message}`}>
                  [{issue.severity}] {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* selected files */}
        {selectedCandidates.length > 0 ? (
          <div className="overflow-x-auto rounded-[6px] border border-line">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="h-7 border-b border-line text-left">
                  <th className="w-8" />
                  <th className="microlabel px-2">File</th>
                  <th className="microlabel px-2">Size</th>
                  <th className="microlabel px-2">Mapping</th>
                </tr>
              </thead>
              <tbody>
                {selectedCandidates.map((c) => {
                  const mapping = selectedImports.get(c.id);
                  const mappingLabel =
                    item.service === "radarr"
                      ? mapping?.movieId
                        ? `movie ${mapping.movieId}`
                        : "—"
                      : mapping?.episodeIds.length
                        ? `episode IDs ${mapping.episodeIds.join(", ")}`
                        : "—";
                  return (
                    <tr key={c.id} className="h-8 border-b border-line last:border-b-0">
                      <td className="px-2">
                        <input
                          type="checkbox"
                          className="accent-[#f0a63a]"
                          checked={selectedIds.has(c.id)}
                          onChange={(e) => toggleInclude(c.id, e.target.checked)}
                        />
                      </td>
                      <td className="max-w-[380px] truncate px-2 font-mono text-[11px] text-ink">
                        {c.relativePath ?? c.path}
                        {c.isLikelySample ? (
                          <span className="ml-1.5 text-nongerman">SAMPLE?</span>
                        ) : null}
                      </td>
                      <td className="px-2 font-mono text-[11px] text-muted">{fmtBytes(c.size)}</td>
                      <td className="px-2 font-mono text-[11px] text-muted">{mappingLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* all-candidates debug */}
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 text-[11px] text-faint hover:text-muted"
          onClick={() => setShowDebug((s) => !s)}
        >
          {showDebug ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          all candidates ({candidates.length})
        </button>
        {showDebug ? (
          <pre className="max-h-[240px] overflow-auto rounded-[6px] border border-line bg-bg p-2 text-[10px] text-muted">
            {JSON.stringify(candidates, null, 2)}
          </pre>
        ) : null}

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <ProposalApplyButton
            action={proposal.action}
            validationOk={validationOk}
            selectedCount={selectedIds.size}
            removalOptions={removalOptions}
            busy={apply.isPending}
            onClick={() => setConfirm("apply")}
          />
          <Button variant="outline" onClick={() => setConfirm("ignore")}>
            Ignore
          </Button>
          <Button variant="danger" onClick={() => setConfirm("remove")}>
            Remove
          </Button>
          <Button variant="danger" onClick={() => setConfirm("blocklist")}>
            Delete + blocklist + search
          </Button>
          {dryRun ? (
            <span className="ml-auto text-[11px] text-accent">dry-run: actions are simulated</span>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirm === "apply"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={applyDialog.title}
        description={applyDialog.description}
        confirmLabel={applyDialog.confirmLabel}
        danger={applyDialog.danger}
        busy={apply.isPending}
        onConfirm={() => {
          apply.mutate({
            analysisId: analysis.id,
            body: applyDialog.body,
          });
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "ignore"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Ignore queue item"
        description="Leaves the download alone and stops proposing fixes for it."
        confirmLabel="Ignore"
        onConfirm={() => {
          ignore.mutate({ service: item.service, id: item.id });
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "remove"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Remove from queue"
        description="Removes the queue item (and download) without blocklisting."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          remove.mutate({
            service: item.service,
            id: item.id,
            body: {
              removeFromClient: true,
              blocklist: false,
              skipRedownload: false,
              changeCategory: false,
            },
          });
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "blocklist"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete + blocklist + search"
        description="Removes the download, blocklists this exact release, and lets the arr search for a different one."
        confirmLabel="Delete + blocklist + search"
        danger
        onConfirm={() => {
          remove.mutate({
            service: item.service,
            id: item.id,
            body: {
              removeFromClient: true,
              blocklist: true,
              skipRedownload: false,
              changeCategory: false,
            },
          });
          setConfirm(null);
        }}
      />
    </Panel>
  );
}
