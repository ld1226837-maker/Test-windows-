import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LayoutPart, LayoutParts } from "./LayoutSection";

/**
 * Passphrase prompt shown BEFORE every Telegram / saved-file restore.
 * The restore always decrypts with the passphrase typed here (never silently
 * with the one stored on this device), so a backup made on another device or
 * under an older passphrase opens as long as the user types the right one.
 * A wrong passphrase keeps the dialog open with an inline error.
 *
 * Registered in Layout & arrangement as `surface.restore-passphrase`.
 */
export function RestorePassphrasePrompt({
  open,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (passphrase: string) => void;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) setValue("");
  }, [open]);

  const submit = () => {
    if (!value || busy) return;
    onSubmit(value);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          setValue("");
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Enter the backup passphrase
          </DialogTitle>
          <DialogDescription>
            Type the passphrase this backup was created with.
          </DialogDescription>
        </DialogHeader>
        <LayoutParts
          surfaceId="surface.restore-passphrase"
          className="space-y-3"
        >
          <LayoutPart id="surface.restore-passphrase.explainer">
            <p className="text-sm text-muted-foreground">
              It is needed every time you restore, so a backup from another
              device or an older passphrase still opens.
            </p>
          </LayoutPart>
          <LayoutPart id="surface.restore-passphrase.input">
            <Input
              type="password"
              autoFocus
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Backup passphrase"
              aria-invalid={Boolean(error)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            {error ? (
              <p role="alert" className="mt-1 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </LayoutPart>
          <LayoutPart id="surface.restore-passphrase.actions">
            <DialogFooter>
              <Button variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button disabled={!value || busy} onClick={submit}>
                {busy ? "Unlocking…" : "Unlock & restore"}
              </Button>
            </DialogFooter>
          </LayoutPart>
        </LayoutParts>
      </DialogContent>
    </Dialog>
  );
}
