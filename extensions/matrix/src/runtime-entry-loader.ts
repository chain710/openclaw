import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/core";
// Statically imported so it loads via jiti's normal CJS require path, avoiding the
// broken require context that occurs inside jiti's ESM-interception dynamic imports.
import { ensureMatrixCryptoRuntime } from "./matrix/deps.js";

type MatrixCryptoBootstrapArgs = {
  log?: (message: string) => void;
};

export type MatrixRuntimeEntryModule = {
  ensureMatrixCryptoRuntime: (args?: MatrixCryptoBootstrapArgs) => Promise<void> | void;
  handleVerifyRecoveryKey: (ctx: GatewayRequestHandlerOptions) => Promise<void>;
  handleVerificationBootstrap: (ctx: GatewayRequestHandlerOptions) => Promise<void>;
  handleVerificationStatus: (ctx: GatewayRequestHandlerOptions) => Promise<void>;
};

type MatrixRuntimeHandlers = Omit<MatrixRuntimeEntryModule, "ensureMatrixCryptoRuntime">;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readFunction<T extends (...args: never[]) => unknown>(
  record: Record<string, unknown>,
  key: string,
): T | null {
  const value = record[key];
  return typeof value === "function" ? (value as T) : null;
}

/**
 * Resolves the three gateway-method handlers from the dynamically-loaded runtime
 * entry module. `ensureMatrixCryptoRuntime` is excluded here because it is provided
 * via a static import in `loadMatrixRuntimeEntryModule` to avoid jiti re-export
 * getter issues in the CJS/ESM interop context.
 */
export function resolveMatrixRuntimeEntryModule(
  moduleExport: unknown,
): MatrixRuntimeHandlers | null {
  const moduleRecord = asRecord(moduleExport);
  if (!moduleRecord) {
    return null;
  }
  const defaultRecord = asRecord(moduleRecord.default);
  const resolved = defaultRecord ?? moduleRecord;

  const handleVerifyRecoveryKey = readFunction<MatrixRuntimeHandlers["handleVerifyRecoveryKey"]>(
    resolved,
    "handleVerifyRecoveryKey",
  );
  const handleVerificationBootstrap = readFunction<
    MatrixRuntimeHandlers["handleVerificationBootstrap"]
  >(resolved, "handleVerificationBootstrap");
  const handleVerificationStatus = readFunction<MatrixRuntimeHandlers["handleVerificationStatus"]>(
    resolved,
    "handleVerificationStatus",
  );

  if (!handleVerifyRecoveryKey || !handleVerificationBootstrap || !handleVerificationStatus) {
    return null;
  }

  return {
    handleVerifyRecoveryKey,
    handleVerificationBootstrap,
    handleVerificationStatus,
  };
}

export async function loadMatrixRuntimeEntryModule(): Promise<MatrixRuntimeEntryModule> {
  const mod = await import("./plugin-entry.runtime.js");
  const handlers = resolveMatrixRuntimeEntryModule(mod);
  if (!handlers) {
    throw new Error("matrix: runtime entry module missing expected exports");
  }
  return { ensureMatrixCryptoRuntime, ...handlers };
}
