import {
  CASH_LABELS,
  STEP_WORD,
  isNegativeBalance,
  stepAmountText,
  type CashStep,
  type DailyTable,
} from "@/lib/daily-table";

/** Tailwind classes per step kind; plus / minus are ALSO spelled out in text. */
const ROW: Record<CashStep["kind"], string> = {
  info: "text-muted-foreground text-xs",
  open: "font-semibold",
  less: "",
  subtotal: "mt-1 border-t border-indigo-900/40 pt-1 font-bold",
  plus: "",
  close:
    "mt-2 rounded-md border-2 border-indigo-900/80 bg-amber-200/80 px-3 py-2 font-bold dark:bg-amber-500/30",
};

/**
 * The cash flow as a semantic ordered list: label + signed amount per step, in
 * the SAME order and with the SAME strings as the picture and the text. The
 * sign is part of the amount ("-340", "+2500") and a screen-reader word
 * ("Minus", "Plus", "Equals") is added, so meaning never depends on colour.
 * Wraps at 360 px; colours have dark-mode variants.
 */
export function CashFlowList({ table }: { table: DailyTable }) {
  return (
    <section
      aria-label="Cash flow"
      data-testid="cash-flow"
      className="rounded-lg border bg-card p-3 text-sm"
    >
      <h3 className="text-xs font-bold tracking-wide text-indigo-900 dark:text-indigo-200">
        CASH FLOW
      </h3>
      <ol className="mt-2 space-y-1">
        {table.cash.steps.map((step) => {
          const negative = isNegativeBalance(step);
          return (
            <li key={step.key} data-step={step.key} className={ROW[step.kind]}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-words">
                  <span className="sr-only">{STEP_WORD[step.kind]}: </span>
                  {step.label}
                </span>
                <span
                  className={`shrink-0 font-mono tabular-nums ${
                    step.kind === "close" ? "text-lg" : ""
                  } ${
                    negative
                      ? "text-red-700 dark:text-red-400"
                      : step.kind === "info"
                        ? ""
                        : "text-indigo-900 dark:text-indigo-100"
                  }`}
                  data-negative={negative ? "true" : undefined}
                >
                  {stepAmountText(step)}
                </span>
              </div>
              {step.hint && (
                <p className="text-[11px] font-normal text-muted-foreground">
                  {step.hint}
                </p>
              )}
              {step.note && (
                <p className="text-[11px] font-normal text-muted-foreground">
                  {step.note}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {CASH_LABELS.caption}
      </p>
    </section>
  );
}
