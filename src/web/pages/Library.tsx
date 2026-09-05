import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type {
  AiVerdictSummary,
  LibraryQuery,
  LibrarySort,
  MovieListItem,
  SeriesListItem,
  StateCounts,
} from "../../shared/api-types.js";
import type { HuntState } from "../../shared/domain.js";
import { ForceControl, PauseControl, ResumeControl } from "../components/ItemActions.js";
import { SegmentedBar } from "../components/SegmentedBar.js";
import {
  DataTable,
  EmptyState,
  Pager,
  Panel,
  SkeletonRows,
  StaleBanner,
  Td,
  Th,
} from "../components/Shell.js";
import { StateBadge } from "../components/StateBadge.js";
import { Input } from "../components/ui/input.js";
import { Tip } from "../components/ui/tooltip.js";
import { relTime } from "../lib/format.js";
import type { LibrarySearchParams } from "../lib/library-search.js";
import { useInvalidateVerdict, useMovieList, useSeriesList } from "../lib/queries.js";
import { FILTER_STATES, STATE_META } from "../lib/states.js";
import { cn } from "../lib/utils.js";

const PAGE_SIZE = 50;

const VERDICT_COLORS: Record<string, string> = {
  exists: STATE_META.german.color,
  announced: STATE_META.unreleased.color,
  unlikely: STATE_META.ai_paused.color,
  unknown: STATE_META.user_paused.color,
};

export function LibraryPage({ kind }: { kind: "series" | "movies" }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as LibrarySearchParams;
  const [qInput, setQInput] = useState(search.q ?? "");

  const to = kind === "series" ? "/library/series" : "/library/movies";
  const setSearch = (patch: Partial<LibrarySearchParams>) => {
    void navigate({ to, search: { ...search, page: undefined, ...patch } });
  };

  // Debounced free-text filter → URL.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run on typed input
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? "") !== qInput) setSearch({ q: qInput || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const query: LibraryQuery = {
    q: search.q,
    states: search.states,
    sort: search.sort,
    order: search.order,
    page: search.page ?? 1,
    pageSize: PAGE_SIZE,
  };

  const seriesQ = useSeriesList(query, kind === "series");
  const moviesQ = useMovieList(query, kind === "movies");
  const active = kind === "series" ? seriesQ : moviesQ;
  const data = active.data;

  const toggleState = (state: HuntState) => {
    const current = search.states ?? [];
    const next = current.includes(state) ? current.filter((s) => s !== state) : [...current, state];
    setSearch({ states: next.length > 0 ? next : undefined });
  };

  const toggleSort = (sort: LibrarySort) => {
    if (search.sort !== sort) setSearch({ sort, order: "asc" });
    else if (search.order !== "desc") setSearch({ sort, order: "desc" });
    else setSearch({ sort: undefined, order: undefined });
  };

  const sortIcon = (sort: LibrarySort) =>
    search.sort === sort ? (
      search.order === "desc" ? (
        <ArrowDown size={10} className="inline text-accent" />
      ) : (
        <ArrowUp size={10} className="inline text-accent" />
      )
    ) : null;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-3">
      <StaleBanner visible={active.isError && data !== undefined} />

      {/* tabs + toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center border-b border-line">
          {(["series", "movies"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() =>
                navigate({
                  to: tab === "series" ? "/library/series" : "/library/movies",
                  search: { ...search, page: undefined },
                })
              }
              className={cn(
                "-mb-px cursor-pointer border-b px-3 py-1.5 text-[12px] font-medium capitalize",
                kind === tab
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              {tab}
            </button>
          ))}
        </div>
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Filter by title…"
          className="w-[220px]"
        />
        <span className="ml-auto font-mono text-[11px] text-muted">
          {data ? `${data.total} items` : ""}
        </span>
      </div>

      {/* state filter chips with counts */}
      <div className="flex flex-wrap gap-1.5">
        {FILTER_STATES.map((state) => {
          const count = data?.stateFilterCounts?.[state] ?? 0;
          const activeChip = search.states?.includes(state) ?? false;
          const meta = STATE_META[state];
          return (
            <button
              key={state}
              type="button"
              onClick={() => toggleState(state)}
              className={cn(
                "flex h-6 cursor-pointer items-center gap-1.5 rounded-[6px] border px-2 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors",
                activeChip ? "bg-raised" : "opacity-70 hover:opacity-100",
              )}
              style={{
                color: meta.color,
                borderColor: activeChip
                  ? meta.color
                  : `color-mix(in srgb, ${meta.color} 35%, transparent)`,
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
              {meta.label}
              <span className="font-mono normal-case tracking-normal">{count}</span>
            </button>
          );
        })}
      </div>

      <Panel>
        <DataTable
          head={
            kind === "series" ? (
              <>
                <SortTh onClick={() => toggleSort("title")}>Title {sortIcon("title")}</SortTh>
                <SortTh onClick={() => toggleSort("state")}>State {sortIcon("state")}</SortTh>
                <Th>Episodes</Th>
                <SortTh onClick={() => toggleSort("german")}>German {sortIcon("german")}</SortTh>
                <Th>AI</Th>
                <SortTh onClick={() => toggleSort("last_search")}>
                  Last search {sortIcon("last_search")}
                </SortTh>
                <SortTh onClick={() => toggleSort("next_search")}>
                  Next {sortIcon("next_search")}
                </SortTh>
                <Th className="text-right">Actions</Th>
              </>
            ) : (
              <>
                <SortTh onClick={() => toggleSort("title")}>Title {sortIcon("title")}</SortTh>
                <SortTh onClick={() => toggleSort("state")}>State {sortIcon("state")}</SortTh>
                <Th>Audio</Th>
                <Th>Quality</Th>
                <Th>AI</Th>
                <SortTh onClick={() => toggleSort("last_search")}>
                  Last search {sortIcon("last_search")}
                </SortTh>
                <SortTh onClick={() => toggleSort("next_search")}>
                  Next {sortIcon("next_search")}
                </SortTh>
                <Th className="text-right">Actions</Th>
              </>
            )
          }
        >
          {active.isPending ? (
            <SkeletonRows rows={10} cols={8} />
          ) : kind === "series" && seriesQ.data ? (
            seriesQ.data.items.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState message="Nothing matches these filters." />
                </td>
              </tr>
            ) : (
              seriesQ.data.items.map((item) => <SeriesRow key={item.id} item={item} />)
            )
          ) : kind === "movies" && moviesQ.data ? (
            moviesQ.data.items.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState message="Nothing matches these filters." />
                </td>
              </tr>
            ) : (
              moviesQ.data.items.map((item) => <MovieRow key={item.id} item={item} />)
            )
          ) : (
            <tr>
              <td colSpan={8}>
                <EmptyState message="Could not load the library." />
              </td>
            </tr>
          )}
        </DataTable>
        {data ? (
          <Pager
            page={query.page ?? 1}
            pageSize={PAGE_SIZE}
            total={data.total}
            onPage={(p) => navigate({ to, search: { ...search, page: p > 1 ? p : undefined } })}
          />
        ) : null}
      </Panel>
    </div>
  );
}

function SortTh({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <th className="px-2">
      <button
        type="button"
        onClick={onClick}
        className="microlabel cursor-pointer font-semibold hover:text-ink"
      >
        {children}
      </button>
    </th>
  );
}

function PosterThumb({ url, title }: { url: string | null; title: string }) {
  return url ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      className="h-7 w-5 shrink-0 rounded-[2px] border border-line object-cover"
    />
  ) : (
    <span className="flex h-7 w-5 shrink-0 items-center justify-center rounded-[2px] border border-line bg-raised text-[9px] text-faint">
      {title.slice(0, 1)}
    </span>
  );
}

function VerdictGlyph({ verdict }: { verdict: AiVerdictSummary | null }) {
  if (!verdict) return <span className="text-faint">—</span>;
  return (
    <Tip
      content={
        <div>
          <div className="microlabel mb-1" style={{ color: VERDICT_COLORS[verdict.verdict] }}>
            {verdict.verdict} · {verdict.confidence.toFixed(2)}
          </div>
          <ul className="list-disc space-y-0.5 pl-4">
            {verdict.evidence.slice(0, 5).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      }
    >
      <span className="inline-flex cursor-help items-center gap-1">
        <Sparkles size={13} style={{ color: VERDICT_COLORS[verdict.verdict] }} />
        <span className="font-mono text-[11px] text-muted">{verdict.confidence.toFixed(2)}</span>
      </span>
    </Tip>
  );
}

function RowActions({
  itemRef,
  verdict,
  paused,
  aiPaused,
  arrUrl,
}: {
  itemRef: { source: "sonarr" | "radarr"; kind: "series" | "movie"; id: number };
  verdict: AiVerdictSummary | null;
  paused: boolean;
  aiPaused: boolean;
  arrUrl: string | null;
}) {
  const invalidate = useInvalidateVerdict();
  const navigate = useNavigate();
  const openLive = () => {
    if (itemRef.kind === "series") {
      void navigate({
        to: "/library/series/$seriesId",
        params: { seriesId: String(itemRef.id) },
        search: { live: true },
      });
    } else {
      void navigate({
        to: "/library/movies/$movieId",
        params: { movieId: String(itemRef.id) },
        search: { live: true },
      });
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stops row navigation under action cluster
    <span
      className="flex items-center justify-end gap-0.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <ForceControl itemRef={itemRef} compact onForced={openLive} />
      {paused || aiPaused ? (
        <ResumeControl
          itemRef={itemRef}
          compact={!aiPaused}
          aiPaused={aiPaused}
          verdict={verdict}
        />
      ) : (
        <PauseControl itemRef={itemRef} compact />
      )}
      {verdict ? (
        <button
          type="button"
          title="Re-check AI verdict"
          className="cursor-pointer rounded p-1 text-muted hover:bg-raised hover:text-ink"
          onClick={() => invalidate.mutate(verdict.id)}
        >
          <RefreshCw size={13} />
        </button>
      ) : null}
      {arrUrl ? (
        <a
          href={arrUrl}
          target="_blank"
          rel="noreferrer"
          title={itemRef.source === "sonarr" ? "Open in Sonarr" : "Open in Radarr"}
          className="rounded p-1 text-muted hover:bg-raised hover:text-ink"
        >
          <ExternalLink size={13} />
        </a>
      ) : null}
    </span>
  );
}

function SeriesRow({ item }: { item: SeriesListItem }) {
  const navigate = useNavigate();
  return (
    <tr
      className="h-8 cursor-pointer border-b border-line hover:bg-raised/60"
      onClick={() =>
        navigate({ to: "/library/series/$seriesId", params: { seriesId: String(item.id) } })
      }
    >
      <Td>
        <span className="flex items-center gap-2">
          <PosterThumb url={item.posterUrl} title={item.title} />
          <Link
            to="/library/series/$seriesId"
            params={{ seriesId: String(item.id) }}
            className="max-w-[320px] truncate text-ink hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {item.title}
          </Link>
          {item.year ? <span className="font-mono text-[11px] text-faint">{item.year}</span> : null}
        </span>
      </Td>
      <Td>
        <StateBadge
          state={item.pause.paused ? "user_paused" : item.state}
          searching={item.searching}
        />
      </Td>
      <Td>
        <SegmentedBar counts={item.episodeCounts as Partial<StateCounts>} scale="row" />
      </Td>
      <Td>
        <span className="font-mono text-[12px]">
          {item.germanEpisodes}/{item.consideredEpisodes}
        </span>
      </Td>
      <Td>
        <VerdictGlyph verdict={item.verdict} />
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{relTime(item.lastSearchAt)}</span>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{relTime(item.nextSearchAt)}</span>
      </Td>
      <Td>
        <RowActions
          itemRef={{ source: "sonarr", kind: "series", id: item.id }}
          verdict={item.verdict}
          paused={item.pause.paused}
          aiPaused={item.state === "ai_paused"}
          arrUrl={item.arrUrl}
        />
      </Td>
    </tr>
  );
}

function MovieRow({ item }: { item: MovieListItem }) {
  const navigate = useNavigate();
  return (
    <tr
      className="h-8 cursor-pointer border-b border-line hover:bg-raised/60"
      onClick={() =>
        navigate({ to: "/library/movies/$movieId", params: { movieId: String(item.id) } })
      }
    >
      <Td>
        <span className="flex items-center gap-2">
          <PosterThumb url={item.posterUrl} title={item.title} />
          <Link
            to="/library/movies/$movieId"
            params={{ movieId: String(item.id) }}
            className="max-w-[320px] truncate text-ink hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {item.title}
          </Link>
          {item.year ? <span className="font-mono text-[11px] text-faint">{item.year}</span> : null}
        </span>
      </Td>
      <Td>
        <StateBadge
          state={item.pause.paused ? "user_paused" : item.state}
          searching={item.searching}
        />
      </Td>
      <Td>
        <span className="flex gap-1">
          {item.audioLanguages.length === 0 ? (
            <span className="text-faint">—</span>
          ) : (
            item.audioLanguages.map((lang) => (
              <span
                key={lang}
                className={cn(
                  "rounded-[3px] border px-1 font-mono text-[10px] uppercase",
                  lang.toLowerCase().startsWith("ger") || lang.toLowerCase() === "de"
                    ? "border-german/50 text-german"
                    : "border-line text-muted",
                )}
              >
                {lang.slice(0, 3)}
              </span>
            ))
          )}
        </span>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{item.quality ?? "—"}</span>
      </Td>
      <Td>
        <VerdictGlyph verdict={item.verdict} />
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{relTime(item.lastSearchAt)}</span>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{relTime(item.nextSearchAt)}</span>
      </Td>
      <Td>
        <RowActions
          itemRef={{ source: "radarr", kind: "movie", id: item.id }}
          verdict={item.verdict}
          paused={item.pause.paused}
          aiPaused={item.state === "ai_paused"}
          arrUrl={item.arrUrl}
        />
      </Td>
    </tr>
  );
}
