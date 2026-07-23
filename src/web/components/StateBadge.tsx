import { type BadgeState, STATE_META } from "../lib/states.js";
import { cn } from "../lib/utils.js";

/**
 * State badge: uppercase 10px letterspaced, 1px border in state color,
 * transparent fill, leading dot. `searching` adds the pulsing cyan overlay dot.
 */
export function StateBadge({
  state,
  searching = false,
  className,
}: {
  state: BadgeState;
  searching?: boolean;
  className?: string;
}) {
  const meta = STATE_META[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[4px] border px-1.5 py-px font-semibold",
        className,
      )}
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 55%, transparent)`,
        fontSize: 10,
        letterSpacing: "0.08em",
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: meta.color }}
      />
      {meta.label}
      {searching ? (
        <span className="search-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-searching" />
      ) : null}
    </span>
  );
}
