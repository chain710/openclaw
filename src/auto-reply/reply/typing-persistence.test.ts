import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createTypingController } from "./typing.js";

describe("typing persistence bug fix", () => {
  let onReplyStartSpy: Mock;
  let onCleanupSpy: Mock;
  let controller: ReturnType<typeof createTypingController>;

  beforeEach(() => {
    vi.useFakeTimers();
    onReplyStartSpy = vi.fn();
    onCleanupSpy = vi.fn();

    controller = createTypingController({
      onReplyStart: onReplyStartSpy,
      onCleanup: onCleanupSpy,
      typingIntervalSeconds: 6,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should CONTINUE typing after markRunComplete is called if dispatcher is busy", async () => {
    // Start typing normally
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run as complete (but not yet dispatch idle)
    controller.markRunComplete();

    // Advance time to trigger the typing interval (6 seconds)
    await vi.advanceTimersByTimeAsync(6001);

    // NEW BEHAVIOR: The typing loop SHOULD call onReplyStart again
    // because the dispatcher is still busy (dispatchIdle is false)
    expect(onReplyStartSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("should stop typing when both runComplete and dispatchIdle are true", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete
    controller.markRunComplete();
    expect(onCleanupSpy).not.toHaveBeenCalled();

    // Mark dispatch idle - should trigger cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);

    // After cleanup, typing interval should not restart typing
    await vi.advanceTimersByTimeAsync(10000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1); // Still only the initial call
  });

  it("should allow typing restart as long as dispatcher is busy", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete
    controller.markRunComplete();

    // Advance time multiple intervals
    await vi.advanceTimersByTimeAsync(20000);

    // Should have triggered multiple keepalives
    expect(onReplyStartSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Eventually dispatch becomes idle and triggers cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);
  });
});
