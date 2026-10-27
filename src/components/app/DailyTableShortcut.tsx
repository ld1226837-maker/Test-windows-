import { useRef, useState } from "react";
import { Image as ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  todayKey,
  useDailyTableActions,
  useDailyTableSource,
} from "@/lib/daily-table-actions";

const LONG_PRESS_MS = 600;

/**
 * Dashboard tile (5th quick action). One tap = build TODAY's table, render the
 * PNG and run the same "Send to owner" flow as the Settings card. Long-press
 * opens a small day picker to send another day.
 */
export function DailyTableShortcut() {
  const { build } = useDailyTableSource();
  const { run, busy, phase } = useDailyTableActions();
  const [pickOpen, setPickOpen] = useState(false);
  const [day, setDay] = useState(todayKey);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const start = () => {
    longPressed.current = false;
    clear();
    timer.current = setTimeout(() => {
      longPressed.current = true;
      setDay(todayKey());
      setPickOpen(true);
    }, LONG_PRESS_MS);
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onPointerDown={start}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          void run("send", build(todayKey()));
        }}
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
          one tap to owner
        </span>
      </button>

      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send table summary for another day</DialogTitle>
          </DialogHeader>
          <Input
            type="date"
            value={day}
            max={todayKey()}
            onChange={(e) => setDay(e.target.value || todayKey())}
            aria-label="Day to send"
          />
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setPickOpen(false);
              void run("send", build(day));
            }}
          >
            Send to owner
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
