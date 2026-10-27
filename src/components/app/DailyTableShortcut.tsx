import { useState } from "react";
import { ArrowLeft, Image as ImageIcon, Loader2, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  parseOldCash,
  todayKey,
  useDailyTableActions,
  useDailyTableSource,
} from "@/lib/daily-table-actions";
import { goToTab } from "@/lib/nav";

type Step = "choose" | "send";

/**
 * Dashboard tile (5th quick action). Tapping it asks how to continue:
 *   1. "Go to Settings" - opens Settings, where the Daily Summary card lives.
 *   2. "Enter old cash and send" - type the old cash (pre-filled with the
 *      saved / carried-over figure), optionally pick another day, and send the
 *      picture to the owner right away.
 */
export function DailyTableShortcut() {
  const { build } = useDailyTableSource();
  const { run, busy, phase } = useDailyTableActions();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("choose");
  const [day, setDay] = useState(todayKey);
  const [oldCashText, setOldCashText] = useState<string | null>(null);

  const reset = () => {
    setStep("choose");
    setDay(todayKey());
    setOldCashText(null);
  };
  const openChooser = () => {
    reset();
    setOpen(true);
  };

  // What the old cash would be if the owner types nothing (saved for that day,
  // else yesterday's final total, else 0).
  const suggested = build(day).oldCash;
  const typed = oldCashText === null ? null : parseOldCash(oldCashText);

  const send = () => {
    setOpen(false);
    void run("send", build(day, typed));
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={openChooser}
        className="flex flex-col items-center gap-1 rounded-xl bg-green-700 p-4 text-sm font-semibold text-white transition-all hover:bg-green-800 disabled:opacity-70"
      >
        <span className="grid size-10 place-items-center rounded-full bg-white/20">
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ImageIcon className="h-5 w-5" />
          )}
        </span>
        <span className="text-center leading-tight">
          {busy
            ? phase === "rendering"
              ? "Making the picture…"
              : "Opening share…"
            : "Send table summary"}
        </span>
        <span className="text-[11px] font-normal opacity-80">
          settings or old cash + send
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send table summary</DialogTitle>
            <DialogDescription>
              {step === "choose"
                ? "How do you want to continue?"
                : "Type the old cash, then send the picture to the owner."}
            </DialogDescription>
          </DialogHeader>

          {step === "choose" ? (
            <div className="grid gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 py-3 text-left"
                onClick={() => {
                  setOpen(false);
                  goToTab("settings");
                }}
              >
                <Settings className="h-5 w-5 shrink-0" />
                <span>
                  <span className="block font-semibold">Go to Settings</span>
                  <span className="block text-xs font-normal opacity-70">
                    Open the Daily Summary card in Settings
                  </span>
                </span>
              </Button>
              <Button
                type="button"
                className="h-auto justify-start gap-3 py-3 text-left"
                onClick={() => setStep("send")}
              >
                <ImageIcon className="h-5 w-5 shrink-0" />
                <span>
                  <span className="block font-semibold">
                    Enter old cash and send
                  </span>
                  <span className="block text-xs font-normal opacity-80">
                    Type the old cash, then send the picture
                  </span>
                </span>
              </Button>
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-1 text-sm">
                <label htmlFor="daily-table-old-cash" className="font-medium">
                  Old cash (Rs)
                </label>
                <Input
                  id="daily-table-old-cash"
                  inputMode="numeric"
                  autoFocus
                  value={oldCashText ?? String(suggested)}
                  onChange={(e) => setOldCashText(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Old cash"
                />
                <span className="text-xs text-muted-foreground">
                  Left empty it uses Rs {suggested}.
                </span>
              </div>
              <div className="grid gap-1 text-sm">
                <label htmlFor="daily-table-day" className="font-medium">
                  Day
                </label>
                <Input
                  id="daily-table-day"
                  type="date"
                  value={day}
                  max={todayKey()}
                  onChange={(e) => {
                    setDay(e.target.value || todayKey());
                    setOldCashText(null);
                  }}
                  aria-label="Day to send"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep("choose")}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  disabled={busy}
                  onClick={send}
                >
                  Send to owner
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
