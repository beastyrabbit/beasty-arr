import { Pause, Play, Zap } from "lucide-react";
import { useState } from "react";
import type { AiVerdictSummary, ForceScope } from "../../shared/api-types.js";
import { type ItemRef, useForceSearch, usePauseItem, useResumeItem } from "../lib/queries.js";
import { Button } from "./ui/button.js";
import { Input, Textarea } from "./ui/input.js";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./ui/popover.js";

/** Force-search button with optional scope popover (series / season / episode). */
export function ForceControl({
  itemRef,
  seasons,
  compact = false,
  withAiRecheckOption = false,
  onForced,
}: {
  itemRef: ItemRef;
  /** When present, offers season-scoped force. */
  seasons?: number[];
  compact?: boolean;
  withAiRecheckOption?: boolean;
  /** Opens the corresponding live detail view after the force request is accepted. */
  onForced?: (scope?: ForceScope) => void;
}) {
  const force = useForceSearch();
  const [recheck, setRecheck] = useState(false);

  if (compact || !seasons || seasons.length === 0) {
    return (
      <Button
        variant={compact ? "ghost" : "primary"}
        size={compact ? "icon" : "md"}
        title="Force search now"
        disabled={force.isPending}
        onClick={() => force.mutate({ ref: itemRef }, { onSuccess: () => onForced?.(undefined) })}
      >
        <Zap size={13} />
        {!compact && "Force now"}
      </Button>
    );
  }

  const dispatch = (scope?: ForceScope) =>
    force.mutate(
      { ref: itemRef, body: { scope, withAiRecheck: recheck || undefined } },
      { onSuccess: () => onForced?.(scope) },
    );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="primary" disabled={force.isPending}>
          <Zap size={13} />
          Force now
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <div className="microlabel mb-2">Search scope</div>
        <div className="flex flex-col gap-1">
          <PopoverClose asChild>
            <Button variant="subtle" className="justify-start" onClick={() => dispatch()}>
              Whole series
            </Button>
          </PopoverClose>
          <div className="grid grid-cols-4 gap-1">
            {seasons.map((n) => (
              <PopoverClose key={n} asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="font-mono"
                  onClick={() => dispatch({ seasonNumber: n })}
                >
                  S{String(n).padStart(2, "0")}
                </Button>
              </PopoverClose>
            ))}
          </div>
        </div>
        {withAiRecheckOption ? (
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={recheck}
              onChange={(e) => setRecheck(e.target.checked)}
              className="accent-[#f0a63a]"
            />
            Re-check AI verdict too
          </label>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

const PAUSE_PRESETS: { label: string; ms: number | null }[] = [
  { label: "1 week", ms: 7 * 86_400_000 },
  { label: "1 month", ms: 30 * 86_400_000 },
  { label: "6 months", ms: 182 * 86_400_000 },
  { label: "Indefinitely", ms: null },
];

/** Pause popover: duration presets, explicit date, note. */
export function PauseControl({
  itemRef,
  compact = false,
}: {
  itemRef: ItemRef;
  compact?: boolean;
}) {
  const pause = usePauseItem();
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");

  const doPause = (until: number | null) =>
    pause.mutate({ ref: itemRef, body: { until, note: note || undefined } });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon" : "md"}
          title="Pause hunting"
          disabled={pause.isPending}
        >
          <Pause size={13} />
          {!compact && "Pause"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <div className="microlabel mb-2">Pause hunting for</div>
        <div className="grid grid-cols-2 gap-1">
          {PAUSE_PRESETS.map((preset) => (
            <PopoverClose key={preset.label} asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => doPause(preset.ms === null ? null : Date.now() + preset.ms)}
              >
                {preset.label}
              </Button>
            </PopoverClose>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1">
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="font-mono text-[11px]"
          />
          <PopoverClose asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={!date}
              onClick={() => doPause(new Date(`${date}T00:00:00`).getTime())}
            >
              Until
            </Button>
          </PopoverClose>
        </div>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          rows={2}
          className="mt-2 text-[12px]"
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Resume control. For ai_paused items it becomes "Override AI & resume" and
 * shows the verdict reasoning before confirming.
 */
export function ResumeControl({
  itemRef,
  aiPaused = false,
  verdict,
  compact = false,
}: {
  itemRef: ItemRef;
  aiPaused?: boolean;
  verdict?: AiVerdictSummary | null;
  compact?: boolean;
}) {
  const resume = useResumeItem();
  const [forceNow, setForceNow] = useState(false);

  if (!aiPaused) {
    if (compact) {
      return (
        <Button
          variant="ghost"
          size="icon"
          title="Resume hunting"
          disabled={resume.isPending}
          onClick={() => resume.mutate({ ref: itemRef })}
        >
          <Play size={13} />
        </Button>
      );
    }
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" disabled={resume.isPending}>
            <Play size={13} />
            Resume
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
            <input
              type="checkbox"
              checked={forceNow}
              onChange={(e) => setForceNow(e.target.checked)}
              className="accent-[#f0a63a]"
            />
            Force a search right away
          </label>
          <PopoverClose asChild>
            <Button
              variant="primary"
              className="mt-3 w-full"
              onClick={() => resume.mutate({ ref: itemRef, body: { force: forceNow } })}
            >
              Resume hunting
            </Button>
          </PopoverClose>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="border-aipaused/60 text-aipaused"
          disabled={resume.isPending}
        >
          <Play size={13} />
          Override AI & resume
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px]">
        <div className="microlabel mb-1 text-aipaused">AI verdict — no dub expected</div>
        {verdict ? (
          <div className="mb-2 text-[12px] text-muted">
            <span className="font-mono text-ink">{verdict.confidence.toFixed(2)}</span> confidence ·{" "}
            {verdict.verdict}
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              {verdict.evidence.slice(0, 4).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={forceNow}
            onChange={(e) => setForceNow(e.target.checked)}
            className="accent-[#f0a63a]"
          />
          Force a search right away
        </label>
        <PopoverClose asChild>
          <Button
            variant="primary"
            className="mt-3 w-full"
            onClick={() =>
              resume.mutate({ ref: itemRef, body: { overrideAi: true, force: forceNow } })
            }
          >
            Override AI & resume
          </Button>
        </PopoverClose>
      </PopoverContent>
    </Popover>
  );
}
