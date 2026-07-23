import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { FixerHistoryEntry } from "../../shared/api-types.js";
import { DataTable, EmptyState, Pager, Panel, SkeletonRows, Td, Th } from "../components/Shell.js";
import { fmtDateTime } from "../lib/format.js";
import { useFixerHistory } from "../lib/queries.js";
import { STATE_META } from "../lib/states.js";

const PAGE_SIZE = 50;

export function FixerHistoryPage() {
  const [page, setPage] = useState(1);
  const history = useFixerHistory({ page, pageSize: PAGE_SIZE });

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
      <div className="flex items-center gap-2">
        <h1 className="text-[15px] font-semibold text-ink">Fixer history</h1>
        <Link
          to="/fixer"
          className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to queue
        </Link>
      </div>
      <Panel>
        <DataTable
          head={
            <>
              <Th className="w-8" />
              <Th>When</Th>
              <Th>Item</Th>
              <Th>Action</Th>
              <Th>By</Th>
              <Th>Confidence</Th>
              <Th>Result</Th>
            </>
          }
        >
          {history.isPending ? (
            <SkeletonRows rows={8} cols={7} />
          ) : history.data && history.data.items.length > 0 ? (
            history.data.items.map((entry) => <HistoryRow key={entry.id} entry={entry} />)
          ) : (
            <tr>
              <td colSpan={7}>
                <EmptyState message="No fixer actions yet." />
              </td>
            </tr>
          )}
        </DataTable>
        {history.data ? (
          <Pager page={page} pageSize={PAGE_SIZE} total={history.data.total} onPage={setPage} />
        ) : null}
      </Panel>
    </div>
  );
}

function HistoryRow({ entry }: { entry: FixerHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const expandable = entry.proposal != null || entry.detail != null;
  return (
    <>
      <tr className="h-8 border-b border-line">
        <Td>
          {expandable ? (
            <button
              type="button"
              className="cursor-pointer text-muted hover:text-ink"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : null}
        </Td>
        <Td>
          <span className="font-mono text-[11px] text-muted">{fmtDateTime(entry.at)}</span>
        </Td>
        <Td>
          <span className="font-mono text-[10px] text-faint">
            {entry.service === "sonarr" ? "S" : "R"}
          </span>
          <span className="ml-2 max-w-[300px] truncate text-[12px] text-ink">
            {entry.itemLabel}
          </span>
        </Td>
        <Td>
          <span className="text-[12px] text-ink">{entry.action}</span>
          {entry.result === "simulated" || entry.dryRun ? (
            <span className="ml-1.5 rounded-[3px] border border-accent/50 px-1 text-[9px] font-semibold tracking-[0.08em] text-accent uppercase">
              simulated
            </span>
          ) : null}
        </Td>
        <Td>
          <span className="microlabel">{entry.sourceKind}</span>
        </Td>
        <Td>
          <span className="font-mono text-[11px] text-muted">
            {entry.confidence?.toFixed(2) ?? "—"}
          </span>
        </Td>
        <Td>
          <span
            className="font-mono text-[11px]"
            style={{
              color:
                entry.result === "error"
                  ? STATE_META.missing.color
                  : entry.result === "ok"
                    ? STATE_META.german.color
                    : undefined,
            }}
          >
            {entry.result}
          </span>
        </Td>
      </tr>
      {open ? (
        <tr className="border-b border-line">
          <td colSpan={7} className="bg-bg p-3">
            <pre className="max-h-[280px] overflow-auto text-[10px] text-muted">
              {JSON.stringify(entry.proposal ?? entry.detail, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
