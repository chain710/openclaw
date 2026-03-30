import { shouldLogVerbose } from "../../globals.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import type { PluginRuntime } from "./types.js";

function forwardRuntimeLog(
  log: ((...args: unknown[]) => void) | undefined,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (!log) {
    return;
  }
  if (meta && Object.keys(meta).length > 0) {
    log(meta, message);
    return;
  }
  log(message);
}

function createRuntimeLogForwarder(
  log: ((...args: unknown[]) => void) | undefined,
): (message: string, meta?: Record<string, unknown>) => void {
  return (message, meta) => {
    forwardRuntimeLog(log, message, meta);
  };
}

export function createRuntimeLogging(): PluginRuntime["logging"] {
  return {
    shouldLogVerbose,
    getChildLogger: (bindings, opts) => {
      const logger = getChildLogger(bindings, {
        level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
      });
      const debug = createRuntimeLogForwarder((...args) => logger.debug?.(...args));
      const info = createRuntimeLogForwarder((...args) => logger.info(...args));
      const warn = createRuntimeLogForwarder((...args) => logger.warn(...args));
      const error = createRuntimeLogForwarder((...args) => logger.error(...args));
      return {
        debug,
        info,
        warn,
        error,
      };
    },
  };
}
