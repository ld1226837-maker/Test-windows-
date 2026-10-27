// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_WIDTH,
  MAX_IMAGE_HEIGHT,
  PIXEL_RATIO,
  canvasToPngBlob,
  dailyTableFileName,
  drawDailyTableCanvas,
  fitFontSize,
  layoutNotes,
  planParts,
  renderDailyTableImages,
} from "./daily-table-image";
import type { DailyTable, DailyTableRow } from "./daily-table";

type Call = { fn: string; args: unknown[] };

/** Recording 2D context: width of text = 0.6 * font px per character. */
function makeCtx(calls: Call[]) {
  const target: Record<string, unknown> = { font: "400 10px x" };
  return new Proxy(target, {
    get(t, k: string) {
      if (k === "measureText")
        return (s: string) => {
          const px = Number(
            /(\d+(?:\.\d+)?)px/.exec(String(t["font"]))?.[1] ?? 10,
          );
          return { width: s.length * px * 0.6 };
        };
      if (k in t) return t[k];
      return (...args: unknown[]) => void calls.push({ fn: k, args });
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

let calls: Call[];
let sizes: { w: number; h: number }[];

beforeEach(() => {
  calls = [];
  sizes = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      sizes.push({ w: this.width, h: this.height });
      return makeCtx(calls) as never;
    } as never,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    cb: BlobCallback,
    type?: string,
  ) {
    cb(new Blob(["png"], { type: type ?? "" }));
  } as never);
});
afterEach(() => vi.restoreAllMocks());

const row = (i: number, o: Partial<DailyTableRow> = {}): DailyTableRow => ({
  key: `r${i}`,
  kind: "booking",
  time: `${i}:00-${i + 1}:00`,
  total: 1200,
  offer: 0,
  advance: 500,
  cash: 100,
  online: 600,
  notes: "",
  ...o,
});

const table = (rows: DailyTableRow[]): DailyTable => ({
  date: "2026-10-27",
  rows,
  totals: { total: 6000, offer: 800, advance: 1100, cash: 1170, online: 2880 },
  cashBlock: { specificCash: 1170, expenses: 0, remainingCash: 1170 },
  expenseList: [],
  expenseTotal: 0,
  oldCash: 2300,
  oldCashIsDefault: false,
  finalTotal: 3470,
});

const drawn = () =>
  calls.filter((c) => c.fn === "fillText").map((c) => String(c.args[0]));
const base = {
  businessName: "Truff Snacks",
  generatedAt: new Date(2026, 9, 27, 21, 45),
};

describe("drawDailyTableCanvas", () => {
  it("is 1080 wide at 2x pixel ratio", () => {
    const c = drawDailyTableCanvas(table([row(5)]), base);
    expect(IMAGE_WIDTH).toBe(1080);
    expect(PIXEL_RATIO).toBe(2);
    expect(c.width).toBe(2160);
    expect(c.height).toBeGreaterThan(0);
    expect(c.height % 2).toBe(0);
  });

  it("draws the title, date, cells, totals, cash block and footer", () => {
    drawDailyTableCanvas(table([row(5, { notes: "extra 30 min" })]), base);
    const t = drawn();
    for (const s of [
      "Truff Snacks",
      "Daily Summary",
      "27-10-2026",
      "TIME",
      "NOTES",
      "5:00-6:00",
      "1200",
      "extra 30 min",
      "ALL TOTAL",
      "6000",
      "2880",
      "SPECIFIC CASH TOTAL (Rs)",
      "THAT DAY EXPENSES (Rs)",
      "REMAINING CASH (Rs)",
      "MANUAL ENTRY OF OLD CASH (Rs)",
      "FINAL TOTAL (Rs)",
      "2300",
      "3470",
      "Generated 27-10-2026 21:45",
    ])
      expect(t, s).toContain(s);
    // Never the rupee glyph.
    expect(t.join("")).not.toContain("\u20b9");
  });

  it("paints the paper colour first and the ledger ink for text", () => {
    drawDailyTableCanvas(table([row(5)]), base);
    const fills = calls.filter((c) => c.fn === "fillRect");
    expect(fills[0]!.args.slice(0, 2)).toEqual([0, 0]);
    expect(drawn().length).toBeGreaterThan(20);
  });

  it("an empty day still renders headers, a message and a zero total", () => {
    drawDailyTableCanvas(
      {
        ...table([]),
        totals: { total: 0, offer: 0, advance: 0, cash: 0, online: 0 },
      },
      base,
    );
    const t = drawn();
    expect(t).toContain("No bookings or sales on this day");
    expect(t).toContain("ALL TOTAL");
  });

  it("31+ rows go on one tall image without throwing", () => {
    const rows = Array.from({ length: 45 }, (_, i) => row(i % 12));
    const c = drawDailyTableCanvas(table(rows), base);
    expect(c.height / PIXEL_RATIO).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
    expect(c.height / PIXEL_RATIO).toBeGreaterThan(45 * 50);
  });

  it("the draw is the same whatever the app theme says", () => {
    document.documentElement.classList.add("dark");
    drawDailyTableCanvas(table([row(5)]), base);
    const dark = drawn();
    calls.length = 0;
    document.documentElement.classList.remove("dark");
    drawDailyTableCanvas(table([row(5)]), base);
    expect(drawn()).toEqual(dark);
  });
});

describe("text fitting", () => {
  const ctx = () => makeCtx([]);
  it("shrinks 1 px at a time and never goes under the minimum", () => {
    const c = ctx();
    const size = fitFontSize(c, "1,23,45,678", 100, 30, 12, 500, "x");
    expect(size).toBeLessThan(30);
    expect(size).toBeGreaterThanOrEqual(12);
    c.font = `500 ${size}px x`;
    expect(c.measureText("1,23,45,678").width).toBeLessThanOrEqual(100);
    expect(fitFontSize(c, "9".repeat(60), 50, 30, 12, 500, "x")).toBe(12);
  });

  it("a long note wraps to two lines at most, ending with an ellipsis if needed", () => {
    const c = ctx();
    const long = "word ".repeat(80);
    const l = layoutNotes(c, long, 266);
    expect(l.lines.length).toBeLessThanOrEqual(2);
    expect(l.lines[1]!.endsWith("\u2026")).toBe(true);
    const short = layoutNotes(c, "extra 30 min and a bit more text here", 266);
    expect(short.lines.length).toBeLessThanOrEqual(2);
    expect(short.lines.join(" ")).toContain("extra");
  });

  it("an unbroken long word is split rather than overflowing", () => {
    const l = layoutNotes(ctx(), "x".repeat(60), 266);
    expect(l.lines.length).toBeLessThanOrEqual(2);
  });

  it("a two-line note makes its row taller than a plain one", () => {
    const c = ctx();
    const parts = planParts(
      c,
      table([
        row(1),
        row(2, {
          notes: "a long note that must wrap onto a second line for sure",
        }),
      ]),
    );
    const [a, b] = parts[0]!.rows;
    expect(b!.height).toBeGreaterThan(a!.height);
  });
});

describe("splitting past the height cap", () => {
  it("splits into numbered parts and only the last carries the totals", () => {
    const rows = Array.from({ length: 160 }, (_, i) => row(i % 12));
    const t = table(rows);
    const parts = planParts(makeCtx([]), t);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts)
      expect(p.height).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
    expect(parts.reduce((n, p) => n + p.rows.length, 0)).toBe(160);

    drawDailyTableCanvas(t, { ...base, partIndex: 0 });
    const first = drawn();
    expect(first).toContain(`Part 1/${parts.length}`);
    expect(first).not.toContain("ALL TOTAL");
    calls.length = 0;
    drawDailyTableCanvas(t, { ...base, partIndex: parts.length - 1 });
    expect(drawn()).toContain("ALL TOTAL");
    expect(drawn()).toContain("3470");
  });
});

describe("files", () => {
  it("names the file with safeFilePart", () => {
    expect(dailyTableFileName("2026-10-27")).toBe(
      "Daily-Summary-27-10-2026.png",
    );
    expect(dailyTableFileName("2026-10-27", { index: 0, count: 2 })).toBe(
      "Daily-Summary-27-10-2026-Part-1-of-2.png",
    );
  });

  it("renders PNG blobs with the right name and size", async () => {
    const out = await renderDailyTableImages(table([row(5)]), base);
    expect(out).toHaveLength(1);
    expect(out[0]!.blob.type).toBe("image/png");
    expect(out[0]!.fileName).toBe("Daily-Summary-27-10-2026.png");
    expect(out[0]!.width).toBe(2160);
  });

  it("rejects when the browser cannot encode, instead of hanging", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      function (cb: BlobCallback) {
        cb(null);
      } as never,
    );
    await expect(
      canvasToPngBlob(document.createElement("canvas")),
    ).rejects.toThrow(/PNG/);
  });

  it("throws a clear error when no 2D context exists", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(() => drawDailyTableCanvas(table([]), base)).toThrow(/Canvas/);
  });
});
