// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { progressPercent, type OpProgress } from "../operation-progress";

describe("operation progress", () => {
  it("uses only phases for the operation kind", () => {
    const p: OpProgress = {
      opId: "1",
      kind: "telegram-upload",
      phase: "uploading",
      label: "Uploading part 1 of 1",
      done: 1,
      total: 1,
      cancellable: false,
    };
    // telegram-upload = preparing 5 + encrypting 15 + uploading 75 + verifying 5
    // + finalizing 5 (no download/restore weights). Finishing the upload phase
    // leaves verifying + finalizing, so it is 95/105, not 100.
    expect(progressPercent(p)).toBeCloseTo((95 / 105) * 100, 5);
    expect(progressPercent({ ...p, phase: "finalizing" })).toBe(100);
  });
  it("never moves backwards within a phase", () => {
    const a: OpProgress = {
      opId: "1",
      kind: "telegram-upload",
      phase: "uploading",
      label: "Uploading",
      done: 1,
      total: 4,
      cancellable: false,
    };
    const b: OpProgress = { ...a, done: 3 };
    expect(progressPercent(b)).toBeGreaterThan(progressPercent(a));
  });
});

describe("operation result lifecycle", () => {
  it("does not let an older result timer clear a newer operation", async () => {
    vi.useFakeTimers();
    const { setOperationProgress, setOperationResult, readOperationProgress } =
      await import("../operation-progress");
    setOperationProgress({
      opId: "old",
      kind: "local-export",
      phase: "writing",
      label: "Saving",
      cancellable: false,
    });
    setOperationResult("success", "old done");
    setOperationProgress({
      opId: "new",
      kind: "local-export",
      phase: "writing",
      label: "Saving",
      cancellable: false,
    });
    vi.advanceTimersByTime(2500);
    expect(readOperationProgress()?.opId).toBe("new");
    setOperationProgress(null);
    vi.useRealTimers();
  });
});

describe("operation lifecycle guard and result banners", () => {
  const visible = () =>
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });

  it("keeps error/warning banners until dismissed, and fades success", async () => {
    vi.useFakeTimers();
    const m = await import("../operation-progress");
    m.setOperationProgress({
      opId: "e",
      kind: "local-export",
      phase: "writing",
      label: "Saving",
      cancellable: false,
    });
    m.setOperationResult("error", "failed");
    vi.advanceTimersByTime(120_000);
    expect(m.readOperationProgress()?.status).toBe("error");
    expect(m.isOperationRunning()).toBe(false);
    m.dismissOperationResult();
    expect(m.readOperationProgress()).toBeNull();
    m.setOperationProgress({
      opId: "s",
      kind: "local-export",
      phase: "writing",
      label: "Saving",
      cancellable: false,
    });
    m.setOperationResult("success", "ok");
    vi.advanceTimersByTime(6100);
    expect(m.readOperationProgress()).toBeNull();
    vi.useRealTimers();
  });

  it("does not let a late progress callback resurrect a finished operation", async () => {
    vi.useFakeTimers();
    const m = await import("../operation-progress");
    m.setOperationProgress({
      opId: "late",
      kind: "local-export",
      phase: "writing",
      label: "Saving",
      cancellable: false,
    });
    m.setOperationResult("success", "ok");
    m.setOperationProgress({
      opId: "late",
      kind: "local-export",
      phase: "writing",
      label: "Saving",
      cancellable: true,
    });
    vi.advanceTimersByTime(200);
    expect(m.readOperationProgress()?.status).toBe("success");
    m.dismissOperationResult();
    vi.useRealTimers();
  });

  it("shows a retry countdown without disturbing done/total", async () => {
    vi.useFakeTimers();
    const m = await import("../operation-progress");
    m.setOperationProgress({
      opId: "r",
      kind: "telegram-upload",
      phase: "uploading",
      label: "Uploading",
      done: 3,
      total: 7,
      cancellable: true,
    });
    vi.advanceTimersByTime(150);
    m.setOperationRetry({ attempt: 2, max: 5, retryAfterMs: 12_000 });
    vi.advanceTimersByTime(150);
    const op = m.readOperationProgress()!;
    expect(op.done).toBe(3);
    expect(op.total).toBe(7);
    expect(op.retry?.attempt).toBe(2);
    expect(
      Math.round((op.retry!.until - Date.now()) / 1000),
    ).toBeGreaterThanOrEqual(11);
    m.setOperationProgress(null);
    vi.useRealTimers();
  });

  it("releases a wake lock that resolves after the operation already finished", async () => {
    visible();
    const release = vi.fn(() => Promise.resolve());
    let resolveLock: (l: { release: typeof release }) => void = () => {};
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: () =>
          new Promise((r) => {
            resolveLock = r as typeof resolveLock;
          }),
      },
    });
    const m = await import("../operation-progress");
    m.setOperationProgress({
      opId: "w",
      kind: "local-export",
      phase: "writing",
      label: "Saving",
      cancellable: false,
    });
    m.setOperationResult("success", "ok");
    resolveLock({ release });
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalled();
    m.dismissOperationResult();
    Reflect.deleteProperty(navigator, "wakeLock");
  });

  it("re-acquires the wake lock after the browser releases it", async () => {
    visible();
    const listeners: Array<() => void> = [];
    const request = vi.fn(() =>
      Promise.resolve({
        release: () => Promise.resolve(),
        addEventListener: (_t: string, cb: () => void) => {
          listeners.push(cb);
        },
      }),
    );
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request },
    });
    const m = await import("../operation-progress");
    m.setOperationProgress({
      opId: "v",
      kind: "local-export",
      phase: "writing",
      label: "Saving",
      cancellable: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    listeners.forEach((cb) => cb()); // browser dropped it (tab hidden)
    await new Promise((r) => setTimeout(r, 150)); // let the throttled progress reach `current`
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    m.setOperationResult("success", "ok");
    m.dismissOperationResult();
    Reflect.deleteProperty(navigator, "wakeLock");
  });
});
