import { LIBRARY_SORTS, type LibrarySort, type SortOrder } from "../../shared/api-types.js";
import { HUNT_STATES, type HuntState } from "../../shared/domain.js";

/** URL-encoded library filters shared by /library/series and /library/movies. */
export type LibrarySearchParams = {
  q?: string;
  states?: HuntState[];
  sort?: LibrarySort;
  order?: SortOrder;
  page?: number;
};

export function validateLibrarySearch(search: Record<string, unknown>): LibrarySearchParams {
  const out: LibrarySearchParams = {};
  if (typeof search.q === "string" && search.q !== "") out.q = search.q;
  const rawStates = Array.isArray(search.states)
    ? search.states
    : typeof search.states === "string"
      ? [search.states]
      : [];
  const states = rawStates.filter((s): s is HuntState =>
    (HUNT_STATES as readonly string[]).includes(String(s)),
  );
  if (states.length > 0) out.states = states;
  if (
    typeof search.sort === "string" &&
    (LIBRARY_SORTS as readonly string[]).includes(search.sort)
  ) {
    out.sort = search.sort as LibrarySort;
  }
  if (search.order === "asc" || search.order === "desc") out.order = search.order;
  const page = Number(search.page);
  if (Number.isInteger(page) && page > 1) out.page = page;
  return out;
}
