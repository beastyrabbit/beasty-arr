import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DataTable, EmptyState, Pager, Panel, SkeletonRows, Td, Th } from "../components/Shell.js";
import { Select } from "../components/ui/select.js";
import { fmtDateTime } from "../lib/format.js";
import { useAttempts, useBudgetLedger, useVerdicts } from "../lib/queries.js";
import { STATE_META } from "../lib/states.js";
import { cn } from "../lib/utils.js";

export type ActivityTab = "searches" | "ai" | "budget";
const PAGE_SIZE = 50;

const TABS: { id: ActivityTab; label: string }[] = [
  { id: "searches", label: "Searches" },
  { id: "ai", label: "AI checks" },
  { id: "budget", label: "Budget ledger" },
];

export function ActivityPage({ tab }: { tab: ActivityTab }) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-3">
      <div className="flex items-center border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => navigate({ to: `/activity/${t.id}` })}
            className={cn(
              "-mb-px cursor-pointer border-b px-3 py-1.5 text-[12px] font-medium",
              tab === t.id
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "searches" ? <SearchesTab /> : tab === "ai" ? <AiTab /> : <BudgetTab />}
    </div>
  );
}

function SearchesTab() {
  const [page, setPage] = useState(1);
  const [trigger, setTrigger] = useState<string>("all");
  const attempts = useAttempts({
    page,
    pageSize: PAGE_SIZE,
    trigger:
      trigger === "all" ? undefined : (trigger as "scheduled" | "forced" | "missing" | "retry"),
  });

  return (
    <Panel
      title="Search attempts"
      actions={
        <Select
          value={trigger}
          onValueChange={(v) => {
            setTrigger(v);
            setPage(1);
          }}
          options={[
            { value: "all", label: "All triggers" },
            { value: "scheduled", label: "Scheduled" },
            { value: "forced", label: "Forced" },
            { value: "missing", label: "Missing" },
            { value: "retry", label: "Retry" },
          ]}
          className="h-6"
        />
      }
    >
      <DataTable
        head={
          <>
            <Th>When</Th>
            <Th>Target</Th>
            <Th>Command</Th>
            <Th>Trigger</Th>
            <Th>Est. queries</Th>
            <Th>Status</Th>
            <Th>Result</Th>
          </>
        }
      >
        {attempts.isPending ? (
          <SkeletonRows rows={10} cols={7} />
        ) : attempts.data && attempts.data.items.length > 0 ? (
          attempts.data.items.map((a) => (
            <tr key={a.id} className="h-8 border-b border-line last:border-b-0">
              <Td>
                <span className="font-mono text-[11px] text-muted">{fmtDateTime(a.createdAt)}</span>
              </Td>
              <Td>
                <span className="font-mono text-[10px] text-faint">
                  {a.source === "sonarr" ? "S" : "R"}
                </span>
                <span className="ml-2 max-w-[280px] truncate text-[12px] text-ink">
                  {a.targetLabel ?? "—"}
                </span>
                {a.dryRun ? (
                  <span className="ml-1.5 rounded-[3px] border border-accent/50 px-1 text-[9px] font-semibold tracking-[0.08em] text-accent uppercase">
                    dry
                  </span>
                ) : null}
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-muted">{a.commandName}</span>
              </Td>
              <Td>
                <span className="microlabel">{a.trigger}</span>
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-muted">{a.estimatedQueries}</span>
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-muted">{a.status}</span>
              </Td>
              <Td>
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      a.result === "grabbed"
                        ? STATE_META.german.color
                        : a.result === "error"
                          ? STATE_META.missing.color
                          : undefined,
                  }}
                >
                  {a.result ?? "—"}
                </span>
              </Td>
            </tr>
          ))
        ) : (
          <tr>
            <td colSpan={7}>
              <EmptyState message="No search attempts logged yet." />
            </td>
          </tr>
        )}
      </DataTable>
      {attempts.data ? (
        <Pager page={page} pageSize={PAGE_SIZE} total={attempts.data.total} onPage={setPage} />
      ) : null}
    </Panel>
  );
}

function AiTab() {
  const [page, setPage] = useState(1);
  const verdicts = useVerdicts({ page, pageSize: PAGE_SIZE });

  return (
    <Panel title="AI dub verdicts">
      <DataTable
        head={
          <>
            <Th>Checked</Th>
            <Th>Title</Th>
            <Th>Verdict</Th>
            <Th>Confidence</Th>
            <Th>Evidence</Th>
            <Th>Re-check</Th>
          </>
        }
      >
        {verdicts.isPending ? (
          <SkeletonRows rows={8} cols={6} />
        ) : verdicts.data && verdicts.data.items.length > 0 ? (
          verdicts.data.items.map((v) => (
            <tr
              key={v.id}
              className={cn(
                "h-8 border-b border-line last:border-b-0",
                v.superseded && "opacity-50",
              )}
            >
              <Td>
                <span className="font-mono text-[11px] text-muted">{fmtDateTime(v.checkedAt)}</span>
              </Td>
              <Td>
                <span className="max-w-[260px] truncate text-[12px] text-ink">{v.title}</span>
                {v.germanTitle ? (
                  <span className="ml-2 text-[11px] text-faint">„{v.germanTitle}“</span>
                ) : null}
              </Td>
              <Td>
                <span
                  className="font-mono text-[11px]"
                  style={{
                    color:
                      v.verdict === "exists"
                        ? STATE_META.german.color
                        : v.verdict === "announced"
                          ? STATE_META.unreleased.color
                          : v.verdict === "unlikely"
                            ? STATE_META.ai_paused.color
                            : undefined,
                  }}
                >
                  {new Set(v.perSeason?.map((entry) => entry.verdict) ?? []).size > 1
                    ? "mixed"
                    : v.verdict}
                </span>
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-muted">{v.confidence.toFixed(2)}</span>
              </Td>
              <Td>
                <span
                  className="block max-w-[320px] truncate text-[11px] text-muted"
                  title={v.evidence.join("\n")}
                >
                  {v.evidence[0] ?? "—"}
                </span>
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-muted">
                  {fmtDateTime(v.recheckAfter)}
                </span>
              </Td>
            </tr>
          ))
        ) : (
          <tr>
            <td colSpan={6}>
              <EmptyState
                message="No AI checks yet."
                hint="The oracle runs nightly on stubborn items."
              />
            </td>
          </tr>
        )}
      </DataTable>
      {verdicts.data ? (
        <Pager page={page} pageSize={PAGE_SIZE} total={verdicts.data.total} onPage={setPage} />
      ) : null}
    </Panel>
  );
}

function BudgetTab() {
  const [page, setPage] = useState(1);
  const ledger = useBudgetLedger({ page, pageSize: PAGE_SIZE });

  return (
    <Panel title="Hourly budget buckets">
      <DataTable
        head={
          <>
            <Th>Hour</Th>
            <Th>Indexer</Th>
            <Th>Observed</Th>
            <Th>Hunt</Th>
            <Th>Organic</Th>
            <Th>Grabs</Th>
          </>
        }
      >
        {ledger.isPending ? (
          <SkeletonRows rows={10} cols={6} />
        ) : ledger.data && ledger.data.items.length > 0 ? (
          ledger.data.items.map((b) => (
            <tr
              key={`${b.indexerId}:${b.hourUtc}`}
              className="h-8 border-b border-line last:border-b-0"
            >
              <Td>
                <span className="font-mono text-[11px] text-muted">
                  {fmtDateTime(b.hourUtc * 3_600_000)}
                </span>
              </Td>
              <Td>
                <span className="text-[12px] text-ink">{b.indexerName}</span>
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-muted">{b.observedQueries}</span>
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-accent">{b.huntQueries}</span>
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-muted">{b.organicQueries}</span>
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-muted">{b.observedGrabs}</span>
              </Td>
            </tr>
          ))
        ) : (
          <tr>
            <td colSpan={6}>
              <EmptyState
                message="No budget buckets yet."
                hint="Buckets fill as Prowlarr stats are snapshotted."
              />
            </td>
          </tr>
        )}
      </DataTable>
      {ledger.data ? (
        <Pager page={page} pageSize={PAGE_SIZE} total={ledger.data.total} onPage={setPage} />
      ) : null}
    </Panel>
  );
}
