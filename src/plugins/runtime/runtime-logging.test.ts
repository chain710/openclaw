import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    childLogger,
    getChildLogger: vi.fn(() => childLogger),
    normalizeLogLevel: vi.fn((level: string) => `normalized:${level}`),
    shouldLogVerbose: vi.fn(() => false),
  };
});

vi.mock("../../globals.js", () => ({
  shouldLogVerbose: hoisted.shouldLogVerbose,
}));

vi.mock("../../logging.js", () => ({
  getChildLogger: hoisted.getChildLogger,
}));

vi.mock("../../logging/levels.js", () => ({
  normalizeLogLevel: hoisted.normalizeLogLevel,
}));

import { createRuntimeLogging } from "./runtime-logging.js";

describe("createRuntimeLogging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards metadata for runtime logger methods", () => {
    const runtimeLogging = createRuntimeLogging();
    const logger = runtimeLogging.getChildLogger({ module: "matrix" }, { level: "info" });
    const meta = { roomId: "!room:example", reason: "no-mention" };

    logger.debug?.("debug message", meta);
    logger.info("info message", meta);
    logger.warn("warn message", meta);
    logger.error("error message", meta);

    expect(hoisted.normalizeLogLevel).toHaveBeenCalledWith("info");
    expect(hoisted.getChildLogger).toHaveBeenCalledWith(
      { module: "matrix" },
      { level: "normalized:info" },
    );
    expect(hoisted.childLogger.debug).toHaveBeenCalledWith(meta, "debug message");
    expect(hoisted.childLogger.info).toHaveBeenCalledWith(meta, "info message");
    expect(hoisted.childLogger.warn).toHaveBeenCalledWith(meta, "warn message");
    expect(hoisted.childLogger.error).toHaveBeenCalledWith(meta, "error message");
  });

  it("logs message only when metadata is empty or missing", () => {
    const runtimeLogging = createRuntimeLogging();
    const logger = runtimeLogging.getChildLogger();

    logger.info("info without meta");
    logger.warn("warn with empty meta", {});

    expect(hoisted.childLogger.info).toHaveBeenCalledWith("info without meta");
    expect(hoisted.childLogger.warn).toHaveBeenCalledWith("warn with empty meta");
  });
});
