import { type ReactNode, useState } from "react";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent } from "./ui/dialog.js";
import { Input } from "./ui/input.js";

/**
 * Tiered confirmation dialog. `danger` gets rose styling; `confirmPhrase`
 * additionally requires typing the phrase (e.g. "live" for the dry-run switch).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  body,
  confirmLabel,
  danger = false,
  confirmPhrase,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  confirmPhrase?: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const phraseOk = !confirmPhrase || typed.trim() === confirmPhrase;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped("");
        onOpenChange(o);
      }}
    >
      <DialogContent
        title={title}
        description={description}
        className={danger ? "border-missing/50" : undefined}
      >
        {body}
        {confirmPhrase ? (
          <div className="mt-3 flex flex-col gap-1">
            <span className="microlabel">
              Type <span className="font-mono text-missing">{confirmPhrase}</span> to confirm
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              spellCheck={false}
              className="font-mono"
            />
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={!phraseOk || busy}
            onClick={() => {
              onConfirm();
              setTyped("");
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
