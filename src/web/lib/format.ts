const RELATIVE_STEPS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60_000, "second"],
  [3_600_000, "minute"],
  [86_400_000, "hour"],
  [604_800_000, "day"],
  [2_629_800_000, "week"],
  [31_557_600_000, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

const DIVISORS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_800_000,
  year: 31_557_600_000,
};

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "narrow" });

/** "5m ago" / "in 2d" / "—" for null. */
export function relTime(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null) return "—";
  const delta = ts - now;
  const abs = Math.abs(delta);
  for (const [limit, unit] of RELATIVE_STEPS) {
    if (abs < limit) {
      return rtf.format(Math.round(delta / DIVISORS[unit]), unit);
    }
  }
  return "—";
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
}

export function fmtDate(ts: number | null | undefined): string {
  if (ts == null) return "—";
  return new Date(ts).toISOString().slice(0, 10);
}

export function fmtTime(ts: number | null | undefined): string {
  if (ts == null) return "—";
  return new Date(ts).toTimeString().slice(0, 8);
}

export function fmtPct(value: number | null | undefined, decimals = 1): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(decimals)}%`;
}

export function fmtNum(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtConfidence(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toFixed(2);
}

/** "S02E04" style label. */
export function epLabel(season: number, episode: number): string {
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  return `S${s}E${e}`;
}
