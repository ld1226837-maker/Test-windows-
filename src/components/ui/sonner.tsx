import { useEffect, useState } from "react";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/** The app's light/dark mode is the `dark` class on <html> (set by the theme
 * code), not the OS setting, so Sonner's own `richColors` palette has to
 * follow that class or success/error toasts stay light in dark mode. Starts
 * as "light" and syncs after mount so server and client markup match. */
function useRootTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const el = document.documentElement;
    const sync = () =>
      setTheme(el.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Errors carry the message the user most needs to read (what failed and
 * what to try next), so they stay on screen longer than other alerts. Callers
 * that pass their own `duration` keep it. Applied once, even across HMR. */
const ERROR_TOAST_MS = 10000;
const patched = toast.error as typeof toast.error & { __longError?: boolean };
if (!patched.__longError) {
  const original = toast.error.bind(toast);
  const wrapped = ((message, data) =>
    original(message, {
      duration: ERROR_TOAST_MS,
      ...data,
    })) as typeof toast.error & { __longError?: boolean };
  wrapped.__longError = true;
  toast.error = wrapped;
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useRootTheme();
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
