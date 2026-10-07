// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "./localdb";
import { useCustomerTabs, type CustomerTab } from "./tabs";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * Regression: with the Android app's query defaults (staleTime 60s,
 * refetchOnMount false→true), an empty first-paint `initialData` used to be
 * treated as fresh, so IndexedDB was never read and Home/lists showed ₹0 and
 * empty until something was edited. `initialDataUpdatedAt: 0` marks that seed
 * as stale so the real read always runs once.
 */
describe("first-paint seed vs IndexedDB", () => {
  it("still loads stored rows when the seed cache is empty", async () => {
    const row: CustomerTab = {
      id: "t-seed",
      customer_key: "p:9876543210",
      customer_name: "Ravi",
      phone: "9876543210",
      status: "open",
      opened_at: "2026-09-01T00:00:00.000Z",
      closed_at: null,
      created_at: "2026-09-01T00:00:00.000Z",
    };
    await db.customer_tabs.put(row);

    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60_000,
          gcTime: 30 * 60_000,
          refetchOnMount: true,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          retry: 0,
        },
      },
    });

    function Probe() {
      const { data } = useCustomerTabs();
      return createElement("output", null, String(data.length));
    }

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(Probe)),
      );
    });

    for (let i = 0; i < 40 && host.textContent !== "1"; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
    }
    expect(host.textContent).toBe("1");
    await act(async () => root.unmount());
  });
});
