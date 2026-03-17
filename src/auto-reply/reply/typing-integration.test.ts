import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyDispatcherWithTyping } from "./reply-dispatcher.js";
import { createTypingController } from "./typing.js";

describe("Typing Integration (Reproduction & Fix)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should NOT permanently stop typing when dispatcher is idle but run is NOT complete", async () => {
    let closed = false;
    let typingStartedCount = 0;

    const typingCallbacks = {
      onReplyStart: vi.fn().mockImplementation(async () => {
        if (closed) {
          return;
        }
        typingStartedCount++;
      }),
      onIdle: vi.fn().mockImplementation(() => {
        closed = true;
      }),
      onCleanup: vi.fn().mockImplementation(() => {
        closed = true;
      }),
    };

    const { dispatcher, replyOptions, markRunComplete } = createReplyDispatcherWithTyping({
      deliver: vi.fn().mockResolvedValue(undefined),
      typingCallbacks,
    });

    const typing = createTypingController({
      onReplyStart: replyOptions.onReplyStart,
      onCleanup: replyOptions.onTypingCleanup,
    });
    replyOptions.onTypingController?.(typing);

    // 1. Start typing
    await typing.onReplyStart();
    expect(typingStartedCount).toBe(1);
    expect(closed).toBe(false);

    // 2. Send a block. Dispatcher will become idle after this.
    dispatcher.sendBlockReply({ text: "block 1" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // closed should STILL be false because markRunComplete() was NEVER called.
    expect(closed).toBe(false);

    // 3. Try to start typing again via the Controller (simulating Matrix re-trigger or heartbeat tick)
    await typing.onReplyStart();

    // typingStartedCount should increment because TypingController now allows
    // re-triggering when active and not yet idle.
    expect(typingStartedCount).toBe(2);

    // 4. Finally complete the run
    markRunComplete();

    // Now it should be closed
    expect(closed).toBe(true);
  });

  it("should allow re-triggering typing even when dispatcher is idle if run is NOT complete", async () => {
    let typingStartedCount = 0;

    const typingCallbacks = {
      onReplyStart: vi.fn().mockImplementation(async () => {
        typingStartedCount++;
      }),
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    };

    const { replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      deliver: vi.fn().mockResolvedValue(undefined),
      typingCallbacks,
    });

    const typing = createTypingController({
      onReplyStart: replyOptions.onReplyStart,
    });
    replyOptions.onTypingController?.(typing);

    // 1. Initial start
    await typing.onReplyStart();
    expect(typingStartedCount).toBe(1);

    // 2. Simulate dispatcher becoming idle (queue empty)
    markDispatchIdle();

    // 3. Re-trigger (simulating Matrix re-trigger after block delivery)
    await typing.onReplyStart();

    // Should allow re-triggering because run is NOT complete
    expect(typingStartedCount).toBe(2);
  });

  it("should continue typing heartbeat after runComplete if dispatcher is NOT idle (keepalive during flush)", async () => {
    vi.useFakeTimers();
    let typingStartedCount = 0;

    const typingCallbacks = {
      onReplyStart: vi.fn().mockImplementation(async () => {
        typingStartedCount++;
      }),
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    };

    const { replyOptions, markRunComplete } = createReplyDispatcherWithTyping({
      deliver: vi.fn().mockResolvedValue(undefined),
      typingCallbacks,
    });

    const typing = createTypingController({
      onReplyStart: replyOptions.onReplyStart,
      typingIntervalSeconds: 0.1, // Fast interval for testing
    });
    replyOptions.onTypingController?.(typing);

    // 1. Start typing loop
    await typing.startTypingLoop();
    const countAfterStart = typingStartedCount;
    expect(countAfterStart).toBeGreaterThan(0);

    // 2. Mark run complete, but NOT dispatch idle
    markRunComplete();

    // 3. Advance fake timers by several intervals — heartbeat must keep firing
    await vi.advanceTimersByTimeAsync(300);

    // Typing heartbeat should continue until BOTH runComplete and dispatchIdle are true.
    expect(typingStartedCount).toBeGreaterThan(countAfterStart);

    typing.cleanup();
  });
});
