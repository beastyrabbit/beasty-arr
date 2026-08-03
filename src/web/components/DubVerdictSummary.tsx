import type { AiVerdictSummary as AiVerdictSummaryValue } from "../../shared/api-types.js";
import { fmtDate, relTime } from "../lib/format.js";
import { cn } from "../lib/utils.js";

function verdictCopy(verdict: AiVerdictSummaryValue): {
  answer: string;
  action: string;
  color: string;
} {
  switch (verdict.verdict) {
    case "exists":
      return {
        answer: "Yes — German dub exists",
        action: "Keep in the hunt for German audio.",
        color: "text-german",
      };
    case "announced":
      return {
        answer: verdict.expectedAvailability
          ? `Planned — ${fmtDate(verdict.expectedAvailability)}`
          : "Planned — date not confirmed",
        action: verdict.expectedAvailability
          ? `Hold until ${fmtDate(verdict.expectedAvailability)}, then resume hunting.`
          : `Hold briefly; AI rechecks ${relTime(verdict.recheckAfter)}.`,
        color: "text-nongerman",
      };
    case "unlikely":
      return {
        answer: "No German dub found",
        action: `Long hold; AI rechecks ${relTime(verdict.recheckAfter)}.`,
        color: "text-aipaused",
      };
    case "unknown":
      return {
        answer: "Not confirmed",
        action: `Keep the normal hunt state; AI rechecks ${relTime(verdict.recheckAfter)}.`,
        color: "text-muted",
      };
  }
}

export function DubVerdictSummary({ verdict }: { verdict: AiVerdictSummaryValue }) {
  const copy = verdictCopy(verdict);
  return (
    <>
      <div className={cn("mt-2 text-[13px] font-medium", copy.color)}>{copy.answer}</div>
      <p className="mt-1 text-[11px] leading-4 text-muted">{copy.action}</p>
      <div className="mt-2 font-mono text-[10px] text-faint">
        confidence {verdict.confidence.toFixed(2)} · checked {relTime(verdict.checkedAt)}
      </div>
      {verdict.evidence.length > 0 ? (
        <details className="mt-2 border-t border-line pt-2 text-[11px] text-muted">
          <summary className="cursor-pointer select-none text-faint hover:text-muted">
            Source evidence ({verdict.evidence.length})
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {verdict.evidence.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
