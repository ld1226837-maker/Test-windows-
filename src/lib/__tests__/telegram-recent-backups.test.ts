import { describe, expect, it } from "vitest";
import { pickRecentBackups, sessionToIso } from "../telegram-backup";

const b = (session: string, id: number) => ({
  session,
  manifestMessageId: id,
  at: sessionToIso(session)!,
});

describe("recent Telegram backups", () => {
  it("shows only the newest five, newest first", () => {
    const list = Array.from({ length: 7 }, (_, i) =>
      b(`2026-10-0${i + 1}T07-09-48-851Z`, 10 + i),
    );
    const out = pickRecentBackups(list);
    expect(out).toHaveLength(5);
    expect(out[0]!.manifestMessageId).toBe(16);
    expect(out[4]!.manifestMessageId).toBe(12);
  });
  it("lists the same backup once", () => {
    const s = "2026-10-08T07-09-48-851Z";
    expect(pickRecentBackups([b(s, 5), b(s, 5)])).toHaveLength(1);
  });
  it("reads the backup time from its name", () => {
    expect(sessionToIso("2026-10-08T07-09-48-851Z")).toBe("2026-10-08T07:09:48.851Z");
  });
});
