import { money } from "@/lib/biz";
import { modeLines, type ModeBreakdown } from "@/lib/payment-breakdown";

/**
 * Small "how it was paid" block: Cash received, Online received (mode) and,
 * for a split, "Cash ₹X + UPI ₹Y". Display only — fed by payment rows.
 */
export function PaymentModeSummary({
  breakdown,
  className = "",
}: {
  breakdown: ModeBreakdown;
  className?: string;
}) {
  const lines = modeLines(breakdown, money);
  if (lines.length === 0) return null;
  return (
    <div
      className={`space-y-0.5 text-xs text-muted-foreground ${className}`}
      data-testid="payment-mode-summary"
    >
      {lines.map((l) => (
        <p key={l.label}>
          {l.label}: <span className="font-medium text-foreground">{l.value}</span>
        </p>
      ))}
    </div>
  );
}
