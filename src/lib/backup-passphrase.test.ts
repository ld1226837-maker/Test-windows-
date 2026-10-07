// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./desktop", () => ({
  isAndroid: () => true,
  isDesktop: () => false,
}));
vi.mock("./android-secure-store", () => ({
  secureSet: vi.fn(async () => {
    throw new Error("Keystore unavailable");
  }),
  secureDelete: vi.fn(async () => undefined),
  secureGet: vi.fn(async () => null),
}));

import { writeBackupPassphrase } from "./backup-passphrase";

describe("backup passphrase security", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invokeMock.mockReset();
  });

  it("never falls back to plaintext localStorage when Android secure storage fails", async () => {
    await expect(writeBackupPassphrase("secret")).rejects.toThrow(
      "Keystore unavailable",
    );
    expect(window.localStorage.getItem("ks:backup-passphrase")).toBeNull();
  });
});
