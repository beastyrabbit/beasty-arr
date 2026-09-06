import { Link } from "@tanstack/react-router";
import { CheckSquare2, FileQuestion, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { MissingEpisodesQuery, MissingGapFilter } from "../../shared/api-types.js";
import { QueryError } from "../components/QueryError.js";
import { DataTable, EmptyState, Pager, Panel, SkeletonRows, Td, Th } from "../components/Shell.js";
import { Button } from "../components/ui/button.js";
import { Field, Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { fmtDate, fmtNum } from "../lib/format.js";
import { useForceMissing, useMissingEpisodes } from "../lib/queries.js";

const PAGE_SIZE = 50;

export function MissingPage() {
  const [titleInput, setTitleInput] = useState("");
  const [title, setTitle] = useState("");
  const [year, setYear] = useState<string>("all");
  const [minimumAgeInput, setMinimumAgeInput] = useState("14");
  const [maximumAttempts, setMaximumAttempts] = useState("");
  const [gap, setGap] = useState<MissingGapFilter>("any");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    const timer = setTimeout(() => {
      setTitle(titleInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [titleInput]);

  const query: MissingEpisodesQuery = {
    q: title || undefined,
    year: year === "all" ? undefined : Number(year),
    minimumAgeDays: Math.min(3650, Math.max(14, Number(minimumAgeInput) || 14)),
    maximumManualAttempts: maximumAttempts === "" ? undefined : Number(maximumAttempts),
    gap,
    page,
    pageSize: PAGE_SIZE,
  };
  const missing = useMissingEpisodes(query);
  const force = useForceMissing();
  const visibleIds = useMemo(
    () => missing.data?.items.map((item) => item.id) ?? [],
    [missing.data],
  );
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const toggleVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) for (const id of visibleIds) next.delete(id);
      else for (const id of visibleIds) next.add(id);
      return next;
    });
  };

  const runSelected = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    force.mutate(ids, { onSuccess: () => setSelected(new Set()) });
  };

  const years = [
    { value: "all", label: "All years" },
    ...(missing.data?.availableYears ?? []).map((item) => ({
      value: String(item.year),
      label: `${item.year} (${fmtNum(item.count)})`,
    })),
  ];

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
        <div>
          <div className="flex items-center gap-2">
            <FileQuestion size={18} className="text-missing" />
            <h1 className="text-[16px] font-semibold text-ink">Missing</h1>
          </div>
          <p className="mt-1 text-[11px] text-muted">
            Manual completeness search. Newest aired gaps come first. Audio language is ignored.
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-[22px] leading-none text-ink">
            {missing.data ? fmtNum(missing.data.total) : "—"}
          </div>
          <div className="microlabel mt-1">matching episodes</div>
        </div>
      </header>

      <Panel title="Filter the gaps">
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Title">
            <Input
              value={titleInput}
              onChange={(event) => setTitleInput(event.target.value)}
              placeholder="Series title…"
            />
          </Field>
          <Field label="Aired in">
            <Select
              value={year}
              onValueChange={(value) => {
                setYear(value);
                setPage(1);
              }}
              options={years}
              className="w-full"
            />
          </Field>
          <Field label="At least days old">
            <Input
              type="number"
              min={14}
              max={3650}
              value={minimumAgeInput}
              onChange={(event) => {
                setMinimumAgeInput(event.target.value);
                setPage(1);
              }}
              onBlur={() => {
                setMinimumAgeInput(
                  String(Math.min(3650, Math.max(14, Number(minimumAgeInput) || 14))),
                );
              }}
              className="font-mono"
            />
          </Field>
          <Field label="At most manual tries">
            <Input
              type="number"
              min={0}
              max={100}
              value={maximumAttempts}
              onChange={(event) => {
                setMaximumAttempts(event.target.value);
                setPage(1);
              }}
              placeholder="Any"
              className="font-mono"
            />
          </Field>
          <Field label="Existing neighbors">
            <Select
              value={gap}
              onValueChange={(value) => {
                setGap(value as MissingGapFilter);
                setPage(1);
              }}
              options={[
                { value: "any", label: "Any gap" },
                { value: "previous", label: "Previous exists" },
                { value: "next", label: "Next exists" },
                { value: "between", label: "Both exist" },
              ]}
              className="w-full"
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Newest gaps first"
        actions={
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted">{selected.size} selected</span>
            <Button
              variant="primary"
              size="sm"
              disabled={selected.size === 0 || force.isPending}
              onClick={runSelected}
            >
              <Zap size={12} /> Search selected now
            </Button>
          </div>
        }
      >
        <DataTable
          head={
            <>
              <Th className="w-10">
                <button type="button" onClick={toggleVisible} title="Select visible episodes">
                  <CheckSquare2
                    size={14}
                    className={allVisibleSelected ? "text-accent" : "text-faint"}
                  />
                </button>
              </Th>
              <Th>Aired</Th>
              <Th>Series</Th>
              <Th>Episode</Th>
              <Th>Neighbors</Th>
              <Th>Manual tries</Th>
              <Th>Status</Th>
            </>
          }
        >
          {missing.isError ? (
            <tr>
              <td colSpan={10}>
                <QueryError query={missing} />
              </td>
            </tr>
          ) : null}
          {missing.isError && !missing.data ? null : missing.isPending ? (
            <SkeletonRows rows={12} cols={7} />
          ) : missing.data?.items.length ? (
            missing.data.items.map((item) => (
              <tr key={item.id} className="h-10 border-b border-line hover:bg-raised/50">
                <Td>
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                    className="accent-[#f0a63a]"
                    aria-label={`Select ${item.seriesTitle} S${item.seasonNumber}E${item.episodeNumber}`}
                  />
                </Td>
                <Td className="whitespace-nowrap font-mono text-[11px] text-muted">
                  {fmtDate(item.airDateUtc)}
                </Td>
                <Td>
                  <Link
                    to="/library/series/$seriesId"
                    params={{ seriesId: String(item.seriesId) }}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {item.seriesTitle}
                  </Link>
                  {item.seriesYear ? (
                    <span className="ml-2 font-mono text-[10px] text-faint">{item.seriesYear}</span>
                  ) : null}
                </Td>
                <Td>
                  <span className="font-mono text-[11px] text-ink">
                    S{String(item.seasonNumber).padStart(2, "0")}E
                    {String(item.episodeNumber).padStart(2, "0")}
                  </span>
                  {item.episodeTitle ? (
                    <span className="ml-2 text-[12px] text-muted">{item.episodeTitle}</span>
                  ) : null}
                </Td>
                <Td>
                  <span className="font-mono text-[11px] text-muted">
                    {item.previousEpisodePresent ? "← present" : "← missing"} ·{" "}
                    {item.nextEpisodePresent ? "present →" : "missing →"}
                  </span>
                </Td>
                <Td className="font-mono text-[11px] text-muted">{item.manualAttempts}</Td>
                <Td>
                  <span className="text-[11px] text-muted">
                    {item.searching ? "searching" : item.queued ? "starting" : "ready"}
                  </span>
                </Td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={7}>
                <EmptyState message="No missing episodes match these filters." />
              </td>
            </tr>
          )}
        </DataTable>
        {missing.data ? (
          <Pager page={page} pageSize={PAGE_SIZE} total={missing.data.total} onPage={setPage} />
        ) : null}
      </Panel>
    </div>
  );
}
