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
    active = false;
    runComplete = false;
    dispatchIdle = false;
  };

  const cleanup = () => {
    log?.(
      `[typing:ctrl] cleanup called sealed=${sealed} active=${active} runComplete=${runComplete} dispatchIdle=${dispatchIdle} loopRunning=${typingLoop.isRunning()}`,
    );
    if (sealed) {
      log?.(`[typing:ctrl] cleanup skipped (already sealed)`);
      return;
    }
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
      log?.(`[typing:ctrl] cleanup: firing onCleanup (active=true)`);
      onCleanup?.();
    }
    resetCycle();
    sealed = true;
    log?.(`[typing:ctrl] cleanup done; controller sealed`);
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
      log?.(`typing TTL reached (${formatTypingTtl(typingTtlMs)}); stopping typing indicator`);
      cleanup();
    }, typingTtlMs);
  };

  const isActive = () => active && !sealed;

  const startGuard = createTypingStartGuard({
    isSealed: () => sealed,
    shouldBlock: () => runComplete && dispatchIdle,
    rethrowOnError: true,
  });

  const triggerTyping = async () => {
    log?.(
      `[typing:ctrl] triggerTyping sealed=${sealed} runComplete=${runComplete} dispatchIdle=${dispatchIdle} active=${active}`,
    );
    const result = await startGuard.run(async () => {
      await onReplyStart?.();
    });
    log?.(`[typing:ctrl] triggerTyping result=${result} tripped=${startGuard.isTripped()}`);
  };

  const typingLoop = createTypingKeepaliveLoop({
    intervalMs: typingIntervalMs,
    onTick: triggerTyping,
  });

  const ensureStart = async () => {
    log?.(
      `[typing:ctrl] ensureStart sealed=${sealed} active=${active} runComplete=${runComplete} dispatchIdle=${dispatchIdle}`,
    );
    if (sealed) {
      log?.(`[typing:ctrl] ensureStart skipped (sealed=true)`);
      return;
    }
    if (!active) {
      active = true;
    }
    await triggerTyping();
  };

  const maybeStopOnIdle = () => {
    if (!active) {
      return;
    }
    // Stop only when the model run is done and the dispatcher queue is empty.
    if (runComplete && dispatchIdle) {
      cleanup();
    }
  };

  const startTypingLoop = async () => {
    log?.(
      `[typing:ctrl] startTypingLoop sealed=${sealed} runComplete=${runComplete} loopRunning=${typingLoop.isRunning()}`,
    );
    if (sealed) {
      log?.(`[typing:ctrl] startTypingLoop skipped (sealed=true)`);
      return;
    }
    if (runComplete) {
      log?.(`[typing:ctrl] startTypingLoop skipped (runComplete=true)`);
      return;
    }
    // Always refresh TTL when called, even if loop already running.
    // This keeps typing alive during long tool executions.
    refreshTypingTtl();
    if (!onReplyStart) {
      return;
    }
    if (typingLoop.isRunning()) {
      log?.(`[typing:ctrl] startTypingLoop: loop already running, TTL refreshed only`);
      return;
    }
    await ensureStart();
    log?.(`[typing:ctrl] startTypingLoop: starting 6s keepalive loop`);
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
    refreshTypingTtl();
    await startTypingLoop();
  };

  let dispatchIdleTimer: NodeJS.Timeout | undefined;
  const DISPATCH_IDLE_GRACE_MS = 10_000;

  const markRunComplete = () => {
    log?.(
      `[typing:ctrl] markRunComplete called sealed=${sealed} dispatchIdle=${dispatchIdle} loopRunning=${typingLoop.isRunning()}`,
    );
    runComplete = true;
    maybeStopOnIdle();
    if (!sealed && !dispatchIdle) {
      log?.(
        `[typing:ctrl] markRunComplete: dispatchIdle not yet received; arming ${DISPATCH_IDLE_GRACE_MS}ms grace timer`,
      );
      dispatchIdleTimer = setTimeout(() => {
        if (!sealed && !dispatchIdle) {
          log?.("typing: dispatch idle not received after run complete; forcing cleanup");
          cleanup();
        }
      }, DISPATCH_IDLE_GRACE_MS);
    }
  };

  const markDispatchIdle = () => {
    log?.(
      `[typing:ctrl] markDispatchIdle called sealed=${sealed} runComplete=${runComplete} active=${active}`,
    );
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
