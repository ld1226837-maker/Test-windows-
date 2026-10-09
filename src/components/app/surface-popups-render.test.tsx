// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MergeCustomersDialog } from "./MergeCustomersDialog";
import { QrScannerDialog } from "./QrScannerDialog";
import type { CustomerRec } from "@/lib/data";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const mount = (ui: React.ReactElement) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient();
  act(() =>
    root!.render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>),
  );
};
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
});

const buttonText = () =>
  [...document.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("pop-ups wired to Layout & arrangement still render everything", () => {
  it("merge-customers pop-up shows explainer, picker and both buttons", () => {
    const customers = [
      { id: "c1", name: "Asha", phone: "9876543210" },
      { id: "c2", name: "Asha K", phone: null },
    ] as CustomerRec[];
    mount(<MergeCustomersDialog customers={customers} />);
    const trigger = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Merge customers"),
    );
    expect(trigger).toBeTruthy();
    act(() => trigger!.click());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Merge duplicate customers");
    expect(text).toContain("Pick the record to keep");
    expect(text).toContain("1. Keep this customer");
    expect(text).toContain("Asha K");
    expect(buttonText()).toEqual(expect.arrayContaining(["Cancel", "Merge"]));
  });

  it("merge-customers pop-up keeps its 'need two customers' notice", () => {
    mount(<MergeCustomersDialog customers={[]} />);
    const trigger = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Merge customers"),
    );
    act(() => trigger!.click());
    expect(document.body.textContent).toContain(
      "You need at least two saved customers to merge.",
    );
  });

  it("QR scanner pop-up shows its hint and the fallback buttons", () => {
    mount(
      <QrScannerDialog
        open
        onOpenChange={vi.fn()}
        onResult={vi.fn()}
        title="Scan Telegram details"
        hint="Scan the setup QR."
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Scan Telegram details");
    expect(text).toContain("Scan the setup QR.");
    expect(buttonText()).toEqual(
      expect.arrayContaining(["Choose image", "Paste", "Enter manually"]),
    );
  });
});
