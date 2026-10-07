import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsPDF } from "jspdf";

import { DEFAULT_PRINT_SETTINGS, type PrintSettings } from "./print";
import { appendReceiptPhotoPages, planPhotoPage } from "./receipt-photo";
import { expenseReceiptDoc } from "./expense-receipt";
import { investmentReceiptDoc } from "./investments";
import { buildReceiptPdfWithPhoto } from "./receipt";
import type { InvestmentRow } from "./localdb";

// A real 2x3 PNG (valid signature + IHDR/IDAT/IEND, correct CRCs) so jsPDF can embed it.
const PNG_2x3 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGM4IScHRAwoFABEDQYZFCZhYwAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const readReceiptBytes = vi.fn<(p: string) => Promise<Uint8Array | null>>();
vi.mock("./receipt-storage", async (orig) => ({
  ...(await orig<typeof import("./receipt-storage")>()),
  readReceiptBytes: (p: string) => readReceiptBytes(p),
}));

// jsdom has no image decoder; the helper only needs the pixel size.
beforeEach(() => {
  readReceiptBytes.mockReset();
  vi.stubGlobal("createImageBitmap", async () => ({
    width: 2,
    height: 3,
    close: () => {},
  }));
});

const roll: PrintSettings = { ...DEFAULT_PRINT_SETTINGS, paper: "80mm" };
const a4: PrintSettings = { ...DEFAULT_PRINT_SETTINGS, paper: "a4" };

describe("planPhotoPage", () => {
  it("roll: keeps the roll width, grows the page to the photo, stays inside it", () => {
    const p = planPhotoPage({
      roll: true,
      pageW: 80,
      pageH: 150,
      imgW: 1000,
      imgH: 1500,
      headerH: 6,
    });
    expect(p.pageW).toBe(80);
    expect(p.drawW).toBeLessThanOrEqual(80 - 6 + 1e-9);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.drawW).toBeLessThanOrEqual(80);
    // page is as tall as caption + photo + gutters, not a fixed A4 height
    expect(p.pageH).toBeCloseTo(6 + p.drawH + 6, 6);
    expect(p.drawH / p.drawW).toBeCloseTo(1.5, 6);
  });
  it("roll: a very tall photo is scaled down instead of making a metre-long page", () => {
    const p = planPhotoPage({
      roll: true,
      pageW: 58,
      pageH: 100,
      imgW: 400,
      imgH: 9000,
      headerH: 6,
    });
    expect(p.pageH).toBeLessThanOrEqual(420 + 1e-9);
    expect(p.drawH / p.drawW).toBeCloseTo(9000 / 400, 6);
  });
  it("sheet: fits inside the sheet and keeps the sheet size", () => {
    const p = planPhotoPage({
      roll: false,
      pageW: 210,
      pageH: 297,
      imgW: 3000,
      imgH: 1000,
      headerH: 10,
    });
    expect([p.pageW, p.pageH]).toEqual([210, 297]);
    expect(p.x).toBeGreaterThanOrEqual(12 - 1e-9);
    expect(p.x + p.drawW).toBeLessThanOrEqual(210 - 12 + 1e-9);
    expect(p.y + p.drawH).toBeLessThanOrEqual(297 - 12 + 1e-9);
  });
});

describe("appendReceiptPhotoPages", () => {
  it("adds the photo as the LAST page, sized to the thermal roll", async () => {
    readReceiptBytes.mockResolvedValue(PNG_2x3);
    const pdf = new jsPDF({ unit: "mm", format: [80, 120] });
    pdf.text("receipt", 5, 5);
    const added = await appendReceiptPhotoPages(
      pdf,
      "Receipts/x.png",
      "EXP-1",
      roll,
    );
    expect(added).toBe(1);
    expect(pdf.getNumberOfPages()).toBe(2);
    pdf.setPage(2);
    expect(pdf.internal.pageSize.getWidth()).toBeCloseTo(80, 3);
    pdf.setPage(1);
    expect(pdf.internal.pageSize.getHeight()).toBeCloseTo(120, 3);
  });

  it("keeps the sheet size on A4", async () => {
    readReceiptBytes.mockResolvedValue(PNG_2x3);
    const pdf = new jsPDF({ unit: "mm", format: "a4" });
    await appendReceiptPhotoPages(pdf, "Receipts/x.png", "INV-1", a4);
    expect(pdf.getNumberOfPages()).toBe(2);
    pdf.setPage(2);
    expect(pdf.internal.pageSize.getWidth()).toBeCloseTo(210, 1);
    expect(pdf.internal.pageSize.getHeight()).toBeCloseTo(297, 1);
  });

  it("throws and leaves NO stray page when the photo is missing or not an image", async () => {
    const pdf = new jsPDF({ unit: "mm", format: [80, 120] });
    readReceiptBytes.mockResolvedValue(null);
    await expect(
      appendReceiptPhotoPages(pdf, "gone.jpg", "X", roll),
    ).rejects.toThrow(/not available/i);
    readReceiptBytes.mockResolvedValue(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    await expect(
      appendReceiptPhotoPages(pdf, "bad.jpg", "X", roll),
    ).rejects.toThrow(/not a readable image/i);
    expect(pdf.getNumberOfPages()).toBe(1);
  });
});

describe("expenseReceiptDoc", () => {
  const exp = (over = {}) => ({
    id: "abcdef123456",
    expense_no: "EXP-20261005-001",
    business: "Turf",
    category: "Maintenance",
    description: "Net repair",
    note: null,
    amount: 1250.5,
    spent_at: "2026-10-05",
    receipt_path: "Receipts/2026-10-05/a.jpg",
    payment_mode: "UPI",
    ...over,
  });
  it("carries the amount, details and the photo path", () => {
    const d = expenseReceiptDoc(exp());
    expect(d.docNo).toBe("EXP-20261005-001");
    expect(d.dateText).toBe("05-10-2026");
    expect(d.lines[0]!.label).toBe("Net repair");
    expect(d.totals.at(-1)).toMatchObject({ label: "Amount", strong: true });
    expect(d.photoPath).toBe("Receipts/2026-10-05/a.jpg");
    expect(d.totals.map((t) => t.label)).toContain("Receipt photo");
  });
  it("has no photo path and no photo row when nothing is attached", () => {
    const d = expenseReceiptDoc(exp({ receipt_path: null, expense_no: null }));
    expect(d.photoPath).toBeNull();
    expect(d.docNo).toBe("EXP-ABCDEF12");
    expect(d.totals.map((t) => t.label)).not.toContain("Receipt photo");
  });
});

describe("buildReceiptPdfWithPhoto", () => {
  const inv = {
    id: "abcdef123456",
    bill_no: "INVES-1",
    investment_date: "2026-10-04",
    amount: 5000,
    category: "Equipment",
    note: "Goal posts",
    payment_mode: "Cash",
    receipt_path: "Receipts/inv.png",
    created_at: "",
    updated_at: "",
    deleted_at: null,
  } as unknown as InvestmentRow;

  it("investment receipt + photo = receipt page(s) then the photo last", async () => {
    readReceiptBytes.mockResolvedValue(PNG_2x3);
    const base = (
      await buildReceiptPdfWithPhoto(
        { ...investmentReceiptDoc(inv), photoPath: null },
        roll,
      )
    ).getNumberOfPages();
    const withPhoto = await buildReceiptPdfWithPhoto(
      investmentReceiptDoc(inv),
      roll,
    );
    expect(withPhoto.getNumberOfPages()).toBe(base + 1);
  });

  it("an unreadable photo does not stop the receipt (default) but does in strict mode", async () => {
    readReceiptBytes.mockResolvedValue(null);
    const doc = investmentReceiptDoc(inv);
    const base = (
      await buildReceiptPdfWithPhoto({ ...doc, photoPath: null }, roll)
    ).getNumberOfPages();
    const pdf = await buildReceiptPdfWithPhoto(doc, roll);
    expect(pdf.getNumberOfPages()).toBe(base);
    await expect(
      buildReceiptPdfWithPhoto(doc, roll, { strict: true }),
    ).rejects.toThrow();
  });
});
