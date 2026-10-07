import { describe, expect, it } from "vitest";
import { customerOutstanding } from "./dues";
import type { TabEntry } from "./tabs";
import { customerOutstandingByCustomer } from "./data";

describe("performance regression guards", () => {
  it("customer due index preserves matchesCustomer phone/name fallback semantics", () => {
    const customers = [
      { id: "1", name: "Alex", phone: "9999999999" },
      { id: "2", name: "Alex", phone: null },
      { id: "3", name: "Ravi", phone: "8888888888" },
    ];
    const bills = [
      {
        id: "b1",
        invoice_no: "B1",
        customer_name: "Alex",
        customer_phone: "9999999999",
        total: 100,
        amount_paid: 40,
        status: "pending",
        payment_mode: "Cash",
        bill_date: "2026-10-01",
      },
      {
        id: "b2",
        invoice_no: "B2",
        customer_name: "Alex",
        customer_phone: null,
        total: 50,
        amount_paid: 0,
        status: "pending",
        payment_mode: "Cash",
        bill_date: "2026-10-02",
      },
    ] as any;
    const bookings = [] as any[];
    const tabEntries: TabEntry[] = [];
    const indexed = customerOutstandingByCustomer(customers, {
      bills,
      bookings,
      tabEntries,
    });
    for (const c of customers) {
      const direct = customerOutstanding(c, {
        bills,
        bookings,
        tabEntries,
        match: (n, p) => {
          const cp = (c.phone ?? "").replace(/\D/g, ""),
            rp = (p ?? "").replace(/\D/g, "");
          return cp && rp
            ? cp === rp
            : (n ?? "").trim().toLowerCase() === c.name.trim().toLowerCase();
        },
      });
      expect(indexed.get(c.id)?.total).toBe(direct.total);
    }
  });
});
