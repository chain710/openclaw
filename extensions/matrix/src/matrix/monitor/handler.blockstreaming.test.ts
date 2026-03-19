import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import * as matrixSdk from "openclaw/plugin-sdk/matrix";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

// Mock the SDK functions imported by the handler
vi.mock("openclaw/plugin-sdk/matrix", async () => {
  const actual = await vi.importActual<any>("openclaw/plugin-sdk/matrix");
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher: vi.fn(),
    createTypingCallbacks: vi.fn(),
    createReplyPrefixOptions: vi.fn(),
  };
});

const viSendTypingMatrixSpy = vi.fn().mockResolvedValue(undefined);
const viDeliverMatrixRepliesSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("../send.js", () => ({
  sendTypingMatrix: (...args: any[]) => viSendTypingMatrixSpy(...args),
  sendMessageMatrix: vi.fn(),
  reactMatrixMessage: vi.fn(),
}));

vi.mock("./replies.js", () => ({
  deliverMatrixReplies: (...args: any[]) => viDeliverMatrixRepliesSpy(...args),
}));

describe("createMatrixRoomMessageHandler blockStreaming", () => {
  let mockCore: any;
  let mockLogger: any;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    mockClient = {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.org"),
      setTyping: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };

    viSendTypingMatrixSpy.mockResolvedValue(undefined);
    viDeliverMatrixRepliesSpy.mockResolvedValue(undefined);

    // Default implementations for SDK mocks
    (matrixSdk.createReplyPrefixOptions as any).mockReturnValue({
      onModelSelected: vi.fn(),
    });

    (matrixSdk.createTypingCallbacks as any).mockImplementation((params: any) => {
      return {
        onReplyStart: async () => {
          await params.start();
        },
        onIdle: () => params.stop?.(),
        onCleanup: () => params.stop?.(),
      };
    });

    (matrixSdk.dispatchReplyFromConfigWithSettledDispatcher as any).mockResolvedValue({
      queuedFinal: true,
      counts: { final: 1 },
    });

    mockCore = {
      channel: {
        routing: {
          resolveAgentRoute: vi
            .fn()
            .mockReturnValue({ agentId: "test-agent", accountId: "acc1", sessionKey: "s1" }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/store"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatInboundEnvelope: vi.fn().mockImplementation(({ body }) => body),
          finalizeInboundContext: vi.fn().mockImplementation((ctx) => ctx),
          resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
          createReplyDispatcherWithTyping: vi.fn().mockImplementation((opts) => {
            return {
              dispatcher: {
                markComplete: vi.fn(),
                waitForIdle: vi.fn().mockResolvedValue(undefined),
                sendToolResult: vi.fn().mockReturnValue(true),
                sendBlockReply: vi.fn().mockReturnValue(true),
                sendFinalReply: vi.fn().mockReturnValue(true),
                getQueuedCounts: vi.fn().mockReturnValue({ tool: 0, block: 0, final: 1 }),
              },
              replyOptions: opts.typingCallbacks,
              markDispatchIdle: vi.fn(),
              // Expose deliver for testing
              deliver: opts.deliver,
            };
          }),
          withReplyDispatcher: vi
            .fn()
            .mockResolvedValue({ queuedFinal: true, counts: { final: 1 } }),
        },
        mentions: {
          buildMentionRegexes: vi.fn().mockReturnValue([/@bot/i]),
          matchesMentionPatterns: vi.fn().mockReturnValue(true),
        },
        commands: { shouldHandleTextCommands: vi.fn().mockReturnValue(false) },
        text: {
          hasControlCommand: vi.fn().mockReturnValue(false),
          resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
        },
        reactions: { shouldAckReaction: vi.fn().mockReturnValue(false) },
      },
      config: { resolveAgentConfig: vi.fn() },
    };
    setMatrixRuntime(mockCore);
  });

  it("passes disableBlockStreaming: true when blockStreaming is false", async () => {
    const handler = createHandler({ blockStreaming: false });
    const event: MatrixRawEvent = {
      type: EventType.RoomMessage,
      event_id: "$msg1",
      sender: "@user:matrix.org",
      origin_server_ts: 2000000,
      content: { msgtype: "m.text", body: "@bot hello" },
    };

    await handler("!room:matrix.org", event);

    const dispatchCall = (matrixSdk.dispatchReplyFromConfigWithSettledDispatcher as any).mock
      .calls[0][0];
    expect(dispatchCall.replyOptions.disableBlockStreaming).toBe(true);
  });

  it("passes disableBlockStreaming: false when blockStreaming is true", async () => {
    const handler = createHandler({ blockStreaming: true });
    const event: MatrixRawEvent = {
      type: EventType.RoomMessage,
      event_id: "$msg1",
      sender: "@user:matrix.org",
      origin_server_ts: 2000000,
      content: { msgtype: "m.text", body: "@bot hello" },
    };

    await handler("!room:matrix.org", event);

    const dispatchCall = (matrixSdk.dispatchReplyFromConfigWithSettledDispatcher as any).mock
      .calls[0][0];
    expect(dispatchCall.replyOptions.disableBlockStreaming).toBe(false);
  });

  it("restores typing status after block delivery with 500ms delay", async () => {
    vi.useFakeTimers();
    try {
      const handler = createHandler({ blockStreaming: true });
      const event: MatrixRawEvent = {
        type: EventType.RoomMessage,
        event_id: "$msg1",
        sender: "@user:matrix.org",
        origin_server_ts: 2000000,
        content: { msgtype: "m.text", body: "@bot hello" },
      };

      await handler("!room:matrix.org", event);

      const deliverFn =
        mockCore.channel.reply.createReplyDispatcherWithTyping.mock.calls[0][0].deliver;
      const typingCallbacks =
        mockCore.channel.reply.createReplyDispatcherWithTyping.mock.calls[0][0].typingCallbacks;

      await typingCallbacks.onReplyStart();
      viSendTypingMatrixSpy.mockClear();

      // Deliver a block
      await deliverFn({ text: "block 1" });

      // Should NOT have restored yet (it's async with 500ms delay)
      expect(viSendTypingMatrixSpy).not.toHaveBeenCalled();

      // Advance 500ms
      await vi.advanceTimersByTimeAsync(500);

      // Verify typing was restored (first false, then true via onReplyStart)
      expect(viSendTypingMatrixSpy).toHaveBeenCalledWith(
        "!room:matrix.org",
        false,
        undefined,
        mockClient,
      );
      expect(viSendTypingMatrixSpy).toHaveBeenCalledWith(
        "!room:matrix.org",
        true,
        undefined,
        mockClient,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts typing restoration if typing is stopped during the 500ms delay", async () => {
    vi.useFakeTimers();
    try {
      const handler = createHandler({ blockStreaming: true });
      await handler("!room:matrix.org", {
        type: EventType.RoomMessage,
        event_id: "$msg1",
        sender: "@user:matrix.org",
        content: { msgtype: "m.text", body: "@bot hello" },
      } as any);

      const deliverFn =
        mockCore.channel.reply.createReplyDispatcherWithTyping.mock.calls[0][0].deliver;
      const typingCallbacks =
        mockCore.channel.reply.createReplyDispatcherWithTyping.mock.calls[0][0].typingCallbacks;

      await typingCallbacks.onReplyStart();
      viSendTypingMatrixSpy.mockClear();

      // Deliver a block
      await deliverFn({ text: "block 1" });

      // Stop typing immediately
      await typingCallbacks.onIdle();
      viSendTypingMatrixSpy.mockClear();

      // Advance past the 500ms restoration delay
      await vi.advanceTimersByTimeAsync(600);

      // Should NOT call setTyping(true) because isTypingActive is now false
      const typingTrueCalls = viSendTypingMatrixSpy.mock.calls.filter((c: any) => c[1] === true);
      expect(typingTrueCalls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects custom typingRestoreDelay configuration", async () => {
    vi.useFakeTimers();
    try {
      const handler = createHandler({ blockStreaming: true, typingRestoreDelay: 800 });
      await handler("!room:matrix.org", {
        type: EventType.RoomMessage,
        event_id: "$msg1",
        sender: "@user:matrix.org",
        content: { msgtype: "m.text", body: "@bot hello" },
      } as any);

      const deliverFn =
        mockCore.channel.reply.createReplyDispatcherWithTyping.mock.calls[0][0].deliver;
      const typingCallbacks =
        mockCore.channel.reply.createReplyDispatcherWithTyping.mock.calls[0][0].typingCallbacks;

      await typingCallbacks.onReplyStart();
      viSendTypingMatrixSpy.mockClear();

      // Deliver a block
      await deliverFn({ text: "block 1" });

      // Advance past default (500ms) but before custom (800ms)
      await vi.advanceTimersByTimeAsync(600);
      expect(viSendTypingMatrixSpy).not.toHaveBeenCalled();

      // Advance past custom 800ms
      await vi.advanceTimersByTimeAsync(200);
      expect(viSendTypingMatrixSpy).toHaveBeenCalledWith(
        "!room:matrix.org",
        false,
        undefined,
        mockClient,
      );
      expect(viSendTypingMatrixSpy).toHaveBeenCalledWith(
        "!room:matrix.org",
        true,
        undefined,
        mockClient,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  function createHandler(params: { blockStreaming?: boolean; typingRestoreDelay?: number } = {}) {
    return createMatrixRoomMessageHandler({
      client: mockClient,
      core: mockCore,
      cfg: {} as any,
      runtime: {} as any,
      logger: mockLogger,
      logVerboseMessage: vi.fn(),
      allowFrom: [],
      roomsConfig: { "!room:matrix.org": { requireMention: true } },
      groupPolicy: "open",
      replyToMode: "off",
      threadReplies: "off",
      dmEnabled: true,
      dmPolicy: "open",
      historyLimit: 0,
      groupHistories: new Map(),
      textLimit: 4000,
      mediaMaxBytes: 1024,
      startupMs: 1000,
      startupGraceMs: 0,
      directTracker: { isDirectMessage: vi.fn().mockResolvedValue(false) } as any,
      getRoomInfo: vi.fn().mockImplementation(async () => ({ name: "Room", altAliases: [] })),
      getMemberDisplayName: vi.fn().mockResolvedValue("User"),
      accountId: "acc1",
      blockStreaming: params.blockStreaming,
      typingRestoreDelay: params.typingRestoreDelay,
    });
  }
});
