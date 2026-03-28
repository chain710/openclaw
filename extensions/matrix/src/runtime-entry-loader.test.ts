import { describe, expect, it, vi } from "vitest";
import { resolveMatrixRuntimeEntryModule } from "./runtime-entry-loader.js";

const mockEntry = {
  ensureMatrixCryptoRuntime: vi.fn(async () => undefined),
  handleVerifyRecoveryKey: vi.fn(async () => undefined),
  handleVerificationBootstrap: vi.fn(async () => undefined),
  handleVerificationStatus: vi.fn(async () => undefined),
};

describe("resolveMatrixRuntimeEntryModule", () => {
  it("resolves named exports from the module object", () => {
    const resolved = resolveMatrixRuntimeEntryModule(mockEntry);
    expect(resolved).not.toBeNull();
    expect(resolved?.handleVerifyRecoveryKey).toBe(mockEntry.handleVerifyRecoveryKey);
  });

  it("resolves handlers from a default export object", () => {
    const resolved = resolveMatrixRuntimeEntryModule({ default: mockEntry });
    expect(resolved).not.toBeNull();
    expect(resolved?.handleVerifyRecoveryKey).toBe(mockEntry.handleVerifyRecoveryKey);
  });

  it("returns null when module export is undefined", () => {
    expect(resolveMatrixRuntimeEntryModule(undefined)).toBeNull();
  });

  it("returns null when required handlers are missing", () => {
    const partial = {
      ensureMatrixCryptoRuntime: mockEntry.ensureMatrixCryptoRuntime,
      handleVerifyRecoveryKey: mockEntry.handleVerifyRecoveryKey,
    };
    expect(resolveMatrixRuntimeEntryModule(partial)).toBeNull();
  });
});
