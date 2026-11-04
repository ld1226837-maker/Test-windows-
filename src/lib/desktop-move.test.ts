// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal in-memory file system whose rename() behaves like the OS: it fails
// with ENOENT when the destination's parent folder does not exist.
const dirs = new Set<string>();
const files = new Map<string, Uint8Array>();
const parent = (p: string) => p.split("/").slice(0, -1).join("/");

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { Document: 1, AppLocalData: 2 },
  mkdir: async (p: string) => {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
  },
  writeFile: async (p: string, b: Uint8Array) => {
    files.set(p, b);
  },
  rename: async (from: string, to: string) => {
    if (!files.has(from) || !dirs.has(parent(to)))
      throw new Error(
        `failed to rename old path: ${from} to new path: ${to} with error: No such file or directory (os error 2)`,
      );
    files.set(to, files.get(from)!);
    files.delete(from);
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  dirname: async (p: string) => parent(p),
  documentDir: async () => "/docs",
  appLocalDataDir: async () => "/local",
  join: async (...a: string[]) => a.join("/"),
}));

import { moveAppDocument, saveToAppDocuments } from "./desktop";

describe("moveAppDocument", () => {
  beforeEach(() => {
    dirs.clear();
    files.clear();
  });

  it("creates a missing destination folder (restore into a fresh install)", async () => {
    await saveToAppDocuments(
      "Receipts/.restore-staging/b1/x.tmp",
      new Uint8Array([1, 2, 3]),
    );
    await moveAppDocument(
      "Receipts/.restore-staging/b1/x.tmp",
      "Receipts/2026-10-25/photo.jpg",
    );
    expect(files.has("TurfApp/Receipts/2026-10-25/photo.jpg")).toBe(true);
    expect(files.has("TurfApp/Receipts/.restore-staging/b1/x.tmp")).toBe(false);
  });

  it("still works when the destination folder already exists", async () => {
    await saveToAppDocuments("Receipts/d/a.tmp", new Uint8Array([9]));
    await saveToAppDocuments("Receipts/d/old.jpg", new Uint8Array([8]));
    await moveAppDocument("Receipts/d/a.tmp", "Receipts/d/new.jpg");
    expect(files.has("TurfApp/Receipts/d/new.jpg")).toBe(true);
  });
});
