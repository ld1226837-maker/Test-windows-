import { useEffect, useRef, useState } from "react";
import { Check, Loader2, PlugZap, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { redact } from "@/lib/backup-log";
import {
  testTelegramConnection,
  type ConnectionStep,
  type ConnectionTestResult,
  type TelegramConfig,
} from "@/lib/telegram-backup";
import { LayoutPart, LayoutParts } from "./LayoutSection";

/**
 * "Test connection" pop-up for the Telegram backup card. Runs the checks as
 * soon as it opens and shows each step as it passes, stopping at the first
 * failure.
 *
 * Registered in Layout & arrangement as `surface.connection-test`
 * (see SURFACE_REGISTRY in `src/lib/layout-parts.ts`).
 */
export function ConnectionTestDialog({
  open,
  onOpenChange,
  cfg,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cfg: TelegramConfig;
}) {
  const [steps, setSteps] = useState<ConnectionStep[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const runId = useRef(0);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const start = async () => {
    const id = ++runId.current;
    setSteps([]);
    setResult(null);
    setRunning(true);
    try {
      const r = await testTelegramConnection(cfgRef.current, (s) => {
        if (runId.current === id) setSteps((prev) => [...prev, s]);
      });
      if (runId.current === id) setResult(r);
    } catch (e) {
      if (runId.current === id)
        setResult({
          ok: false,
          steps: [],
          message: redact(e instanceof Error ? e.message : String(e)),
        });
    } finally {
      if (runId.current === id) setRunning(false);
    }
  };

  useEffect(() => {
    if (open) {
      void start();
    } else {
      runId.current++; // ignore anything still in flight
      setSteps([]);
      setResult(null);
      setRunning(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlugZap className="h-4 w-4" /> Test Telegram connection
          </DialogTitle>
          <DialogDescription>
            Checks everything backup and restore need.
          </DialogDescription>
        </DialogHeader>
        <LayoutParts surfaceId="surface.connection-test" className="space-y-3">
          <LayoutPart id="surface.connection-test.explainer">
            <p className="text-sm text-muted-foreground">
              Sends one tiny test file to your chat, downloads it back, then
              deletes it. Stops at the first problem and says which step failed.
            </p>
          </LayoutPart>
          <LayoutPart id="surface.connection-test.steps">
            <ul className="space-y-1.5 text-sm" aria-live="polite">
              {steps.map((s) => (
                <li key={s.name} className="flex items-start gap-2">
                  {s.ok ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  )}
                  <span>
                    {s.name}
                    {s.ok && s.detail ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {s.detail}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
              {running && (
                <li className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking…
                </li>
              )}
            </ul>
          </LayoutPart>
          <LayoutPart id="surface.connection-test.result">
            {result ? (
              <p
                role={result.ok ? "status" : "alert"}
                className={
                  result.ok
                    ? "text-sm text-emerald-600"
                    : "text-sm text-destructive"
                }
              >
                {result.message}
              </p>
            ) : (
              <span />
            )}
          </LayoutPart>
          <LayoutPart id="surface.connection-test.actions">
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button disabled={running} onClick={() => void start()}>
                Run again
              </Button>
            </DialogFooter>
          </LayoutPart>
        </LayoutParts>
      </DialogContent>
    </Dialog>
  );
}
