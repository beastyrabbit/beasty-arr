import { cn } from "../lib/utils.js";

export type LedState = "live" | "reconnecting" | "down" | "off";

const LED_COLORS: Record<LedState, string> = {
  live: "#34d399",
  reconnecting: "#f0a63a",
  down: "#fb7185",
  off: "#5c6370",
};

/** LED liveness dot: green pulse live / amber reconnecting / red down. */
export function LedDot({ state, className }: { state: LedState; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        state === "live" && "led-pulse",
        className,
      )}
      style={{ background: LED_COLORS[state] }}
      title={state}
    />
  );
}
