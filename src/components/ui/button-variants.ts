import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex min-w-0 touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium cursor-pointer transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_6px_18px_-8px_var(--primary)] hover:bg-primary/90 hover:shadow-[0_10px_24px_-10px_var(--primary)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "frost-soft border border-border/70 shadow-sm hover:bg-accent/60 hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent/70 hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "relative h-9 px-4 py-2 after:absolute after:inset-x-0 after:-inset-y-1.5",
        /** Visually 32px, but an invisible ::after grows the tappable area to
         * 48px tall (Material's minimum touch target) without changing the
         * layout. Only vertical, so neighbours in a row don't overlap. */
        sm: "relative h-8 rounded-lg px-3 text-xs after:absolute after:inset-x-0 after:-inset-y-2",
        lg: "h-10 rounded-xl px-8",
        /** 36px visually; ::after extends the hit area to 48x48. */
        icon: "relative h-9 w-9 after:absolute after:-inset-1.5",
        /** Android's own Material guidance (and the plan) call for a 48dp
         * minimum touch target — size-11 (44px) was under that bar. */
        touch: "size-12 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
