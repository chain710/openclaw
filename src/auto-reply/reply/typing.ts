import { createTypingKeepaliveLoop } from "../../channels/typing-lifecycle.js";
import { createTypingStartGuard } from "../../channels/typing-start-guard.js";
import { isSilentReplyPrefixText, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

export type TypingController = {
  onReplyStart: () => Promise<void>;
  startTypingLoop: () => Promise<void>;
  startTypingOnText: (text?: string) => Promise<void>;
  refreshTypingTtl: () => void;
  isActive: () => boolean;
  markRunComplete: () => void;
  markDispatchIdle: () => void;
  cleanup: () => void;
};

export function createTypingController(params: {
  onReplyStart?: () => Promise<void> | void;
  onCleanup?: () => void;
  typingIntervalSeconds?: number;
  typingTtlMs?: number;
  silentToken?: string;
  log?: (message: string) => void;
}): TypingController {
  const {
    onReplyStart,
    onCleanup,
    typingIntervalSeconds = 6,
    typingTtlMs = 2 * 60_000,
    silentToken = SILENT_REPLY_TOKEN,
    log,
  } = params;
  let started = false;
  let active = false;
  let runComplete = false;
  let dispatchIdle = false;
  // Important: callbacks (tool/block streaming) can fire late (after the run completed),
  // especially when upstream event emitters don't await async listeners.
  // Once we stop typing, we "seal" the controller so late events can't restart typing forever.
  let sealed = false;
  let typingTtlTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs = typingIntervalSeconds * 1000;

  const formatTypingTtl = (ms: number) => {
    if (ms % 60_000 === 0) {
      return `${ms / 60_000}m`;
    }
    return `${Math.round(ms / 1000)}s`;
  };

  const resetCycle = () => {
    started = false;
    active = false;
    runComplete = false;
    dispatchIdle = false;
  };

  const cleanup = () => {
    if (sealed) {
      return;
    }
    log?.(
      `[Typing:Controller] cleanup: sealing controller (active=${active}, runComplete=${runComplete}, dispatchIdle=${dispatchIdle})`,
    );
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
      typingTtlTimer = undefined;
    }
    if (dispatchIdleTimer) {
      clearTimeout(dispatchIdleTimer);
      dispatchIdleTimer = undefined;
    }
    typingLoop.stop();
    // Notify the channel to stop its typing indicator (e.g., on NO_REPLY).
    // This fires only once (sealed prevents re-entry).
    if (active) {
      onCleanup?.();
    }
    resetCycle();
    sealed = true;
  };

  const refreshTypingTtl = () => {
    if (sealed) {
      return;
    }
    if (!typingIntervalMs || typingIntervalMs <= 0) {
      return;
    }
    if (typingTtlMs <= 0) {
      return;
    }
    if (typingTtlTimer) {
      clearTimeout(typingTtlTimer);
    }
    typingTtlTimer = setTimeout(() => {
      if (!typingLoop.isRunning()) {
        return;
      }
      log?.(`[Typing:Controller] TTL reached (${formatTypingTtl(typingTtlMs)}); auto-cleaning`);
      log?.(`typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`);
      cleanup();
    }, typingTtlMs);
  };

  const isActive = () => active && !sealed;

  const startGuard = createTypingStartGuard({
    isSealed: () => sealed,
    shouldBlock: () => runComplete,
    rethrowOnError: true,
  });

  const triggerTyping = async () => {
    log?.(`[Typing:Controller] triggerTyping: calling underlying onReplyStart`);
    await startGuard.run(async () => {
      await onReplyStart?.();
    });
  };

  const typingLoop = createTypingKeepaliveLoop({
    intervalMs: typingIntervalMs,
    onTick: triggerTyping,
  });

  const ensureStart = async () => {
    if (sealed) {
      log?.(`[Typing:Controller] ensureStart: skipped (sealed=true)`);
      return;
    }
    // Late callbacks after a run completed should never restart typing.
    if (runComplete) {
      log?.(`[Typing:Controller] ensureStart: skipped (runComplete=true)`);
      return;
    }
    if (!active) {
      active = true;
    }
    if (started) {
      log?.(`[Typing:Controller] ensureStart: already started`);
      return;
    }
    log?.(`[Typing:Controller] ensureStart: triggering initial typing`);
    started = true;
    await triggerTyping();
  };

  const maybeStopOnIdle = () => {
    if (!active) {
      return;
    }
    // Stop only when the model run is done and the dispatcher queue is empty.
    if (runComplete && dispatchIdle) {
      log?.(`[Typing:Controller] maybeStopOnIdle: conditions met, cleaning up`);
      cleanup();
    }
  };

  const startTypingLoop = async () => {
    if (sealed) {
      return;
    }
    if (runComplete) {
      return;
    }
    // Always refresh TTL when called, even if loop already running.
    // This keeps typing alive during long tool executions.
    refreshTypingTtl();
    if (!onReplyStart) {
      return;
    }
    if (typingLoop.isRunning()) {
      return;
    }
    log?.(`[Typing:Controller] startTypingLoop: starting 6s keepalive loop`);
    await ensureStart();
    typingLoop.start();
  };

  const startTypingOnText = async (text?: string) => {
    if (sealed) {
      return;
    }
    const trimmed = text?.trim();
    if (!trimmed) {
      return;
    }
    if (
      silentToken &&
      (isSilentReplyText(trimmed, silentToken) || isSilentReplyPrefixText(trimmed, silentToken))
    ) {
      return;
    }
    log?.(`[Typing:Controller] startTypingOnText: text arrived, ensuring loop`);
    refreshTypingTtl();
    await startTypingLoop();
  };

  let dispatchIdleTimer: NodeJS.Timeout | undefined;
  const DISPATCH_IDLE_GRACE_MS = 10_000;

  const markRunComplete = () => {
    log?.(`[Typing:Controller] markRunComplete: setting runComplete=true`);
    runComplete = true;
    maybeStopOnIdle();
    if (!sealed && !dispatchIdle) {
      dispatchIdleTimer = setTimeout(() => {
        if (!sealed && !dispatchIdle) {
          log?.(
            `[Typing:Controller] markRunComplete: DISPATCH_IDLE_GRACE_MS reached, forcing cleanup`,
          );
          log?.("typing: dispatch idle not received after run complete; forcing cleanup");
          cleanup();
        }
      }, DISPATCH_IDLE_GRACE_MS);
    }
  };

  const markDispatchIdle = () => {
    log?.(`[Typing:Controller] markDispatchIdle: setting dispatchIdle=true`);
    dispatchIdle = true;
    if (dispatchIdleTimer) {
      clearTimeout(dispatchIdleTimer);
      dispatchIdleTimer = undefined;
    }
    maybeStopOnIdle();
  };

  return {
    onReplyStart: ensureStart,
    startTypingLoop,
    startTypingOnText,
    refreshTypingTtl,
    isActive,
    markRunComplete,
    markDispatchIdle,
    cleanup,
  };
}
