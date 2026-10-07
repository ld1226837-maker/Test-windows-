// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { InvestmentActions } from "./InvestmentActions";
import { PlayerDialog, TeamDialog } from "./TeamDialogs";
import type { InvestmentRow, TeamRow } from "@/lib/localdb";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const inv = {
  id: "i1",
  bill_no: "INVES-20261004-001",
  investment_date: "2026-10-04",
  amount: 1250,
  category: "Equipment",
  note: "Net",
  payment_mode: "Cash",
  receipt_path: "x.jpg",
} as InvestmentRow;
const team = {
  id: "t1",
  customer_id: "c1",
  name: "Lions",
  notes: null,
} as TeamRow;

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

describe("investment action row", () => {
  it("shows labelled Edit / PDF / Print buttons and a More menu; Delete is not a top-level button", () => {
    mount(
      <InvestmentActions
        r={inv}
        onEdit={vi.fn()}
        onShowReceipt={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const labels = [...document.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "Edit investment",
      "Create investment PDF",
      "Print investment statement",
      "More actions",
    ]);
    expect(document.body.textContent).toContain("Edit");
    expect(document.body.textContent).toContain("PDF");
    expect(document.body.textContent).toContain("Print");
  });
  it("Edit calls back with the row", () => {
    const onEdit = vi.fn();
    mount(
      <InvestmentActions
        r={inv}
        onEdit={onEdit}
        onShowReceipt={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    act(() =>
      (
        document.querySelector(
          '[aria-label="Edit investment"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(onEdit).toHaveBeenCalledWith(inv);
  });
});

describe("team dialogs", () => {
  it("Add team dialog opens with a name field and an optional players section", () => {
    mount(
      <TeamDialog
        open
        onOpenChange={vi.fn()}
        customerId="c1"
        customerName="Ravi"
        siblings={[]}
      />,
    );
    expect(document.body.textContent).toContain("Add team");
    expect(document.body.textContent).toContain("A team under Ravi");
    expect(document.querySelector("#team-name")).not.toBeNull();
    expect(document.body.textContent).toContain("Add players now");
  });
  it("Rename mode pre-fills the name and hides the players section", () => {
    mount(
      <TeamDialog
        open
        onOpenChange={vi.fn()}
        customerId="c1"
        siblings={[team]}
        team={team}
      />,
    );
    expect(
      (document.querySelector("#team-name") as HTMLInputElement).value,
    ).toBe("Lions");
    expect(document.body.textContent).toContain("Rename team");
    expect(document.body.textContent).not.toContain("Add players now");
  });
  it("Player dialog offers Save & add another only when adding", () => {
    mount(<PlayerDialog open onOpenChange={vi.fn()} team={team} />);
    expect(document.body.textContent).toContain("Save & add another");
    expect(document.querySelector("#player-phone")).not.toBeNull();
  });
});
