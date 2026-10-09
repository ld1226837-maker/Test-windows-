import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { beginAndroidExportStream } from "./desktop";

describe("beginAndroidExportStream.finish", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  async function stream(finishResult: unknown) {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd.endsWith("|start_stream_save")) return { sessionId: "s1" };
      if (cmd.endsWith("|finish_stream_save")) return finishResult;
      return undefined;
    });
    return beginAndroidExportStream("x.db", "application/octet-stream");
  }

  it("reports saved when native returns saved:true", async () => {
    const out = await stream({ saved: true, path: "content://dl/1" });
    expect(await out.finish()).toEqual({
      saved: true,
      path: "content://dl/1",
    });
  });

  it("regression: a result with only a path (saved flag dropped by the Rust layer) is still a success", async () => {
    const out = await stream({ path: "content://dl/2" });
    const r = await out.finish();
    expect(r.saved).toBe(true);
    expect(r.path).toBe("content://dl/2");
  });

  it("reports failure with the reason when saved is false", async () => {
    const out = await stream({ saved: false, error: "disk full" });
    expect(await out.finish()).toMatchObject({
      saved: false,
      error: "disk full",
    });
  });

  it("reports failure when the command rejects", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd.endsWith("|start_stream_save")) return { sessionId: "s1" };
      if (cmd.endsWith("|finish_stream_save"))
        throw "Storage permission denied";
      return undefined;
    });
    const out = await beginAndroidExportStream(
      "x.db",
      "application/octet-stream",
    );
    expect((await out.finish()).saved).toBe(false);
  });
});
