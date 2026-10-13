// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { useCreateSnackSale } from "./ops";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const walk = (dir: string, out: string[] = []) => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)) out.push(p);
  }
  return out;
};
const SRC = path.resolve(__dirname, "..");
const files = walk(SRC);

describe("suite audit regressions", () => {
  it("a paid snack sale refreshes the payments cache (split + drawer)", async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    let mutate!: ReturnType<typeof useCreateSnackSale>["mutateAsync"];
    const Probe = () => {
      mutate = useCreateSnackSale().mutateAsync;
      return null;
    };
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await mutate({
        sale_date: new Date().toISOString(),
        customer_name: "Ravi",
        items: [
          {
            item_name: "Chips",
            qty: 1,
            unit_price: 50,
            cost_price: 30,
            amount: 50,
          },
        ],
        total: 50,
        profit: 20,
        payment_mode: "Cash",
        notes: null,
        booking_id: null,
        booking_no: null,
        merged_into_bill_id: null,
        initialPayment: [{ mode: "Cash", amount: 50 }],
      } as never);
    });
    const keys = spy.mock.calls.map(
      (c) => (c[0] as { queryKey: string[] }).queryKey[0],
    );
    expect(keys).toContain("payments");
    expect(keys).toContain("snack_sales");
    await act(async () => root.unmount());
  });

  it("no UTC date-key pattern outside the IST helper", () => {
    const bad = files.filter(
      (f) =>
        !f.endsWith(path.join("lib", "utils.ts")) &&
        // synthetic data generators for stress tests, not user-facing keys
        !/(loadtest|receipt-scale)/.test(f) &&
        /toISOString\(\)\s*\.(slice\(0,\s*10\)|split\("T"\)\[0\])/.test(
          fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
        ),
    );
    expect(bad.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("cancelled / no-show are decided only by bill-state helpers", () => {
    const allow =
      /(loadtest|record-state|bill-state|calendar-events|OperationProgressBar|remaining-summary)/;
    const re =
      /(status\s*[!=]==\s*"(Cancelled|No-show)")|(\.cancelled\s*(\)|&&|\|\||\?|;))|(!\w+\.cancelled\b)/;
    const bad: string[] = [];
    for (const f of files) {
      if (allow.test(f)) continue;
      fs.readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*\/\//.test(line)) return;
          // TurfTab colours a status chip by its own label: styling only.
          if (
            /TurfTab/.test(f) &&
            /\bb\.status === "(Cancelled|No-show)" &&/.test(line)
          )
            return;
          if (re.test(line))
            bad.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
