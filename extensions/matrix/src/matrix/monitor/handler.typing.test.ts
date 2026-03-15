import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType } from "./types.js";

const mockOnReplyStart = vi.fn().mockResolvedValue(undefined);

vi.mock("openclaw/plugin-sdk/matrix", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher: vi
      .fn()
      .mockResolvedValue({ queuedFinal: true, counts: { final: 1 } }),
    createTypingCallbacks: vi.fn().mockImplementation(() => ({
      onReplyStart: mockOnReplyStart,
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    })),
    resolveControlCommandGate: vi
      .fn()
      .mockReturnValue({ commandAuthorized: true, shouldBlock: false }),
    createScopedPairingAccess: vi.fn().mockReturnValue({
      readStoreForDmPolicy: vi.fn().mockResolvedValue([]),
    }),
  };
});

vi.mock("./access-policy.js", () => ({
  resolveMatrixAccessState: vi.fn().mockResolvedValue({
    access: { decision: "allow", effectiveAllowFrom: [], effectiveGroupAllowFrom: [] },
    effectiveAllowFrom: [],
    effectiveGroupAllowFrom: [],
    groupAllowConfigured: false,
  }),
  enforceMatrixDirectMessageAccess: vi.fn().mockResolvedValue(true),
}));

describe("Matrix Handler Typing and Streaming Integration", () => {
  it("re-signals typing after each block delivery", async () => {
    let deliverCallback: ((payload: { text?: string }) => Promise<void>) | undefined;

    const core = {
      config: { loadConfig: vi.fn().mockReturnValue({}) },
      channel: {
        pairing: {
          readAllowFromStore: vi.fn().mockResolvedValue([]),
          readStoreForDmPolicy: vi.fn().mockResolvedValue([]),
        },
        routing: {
          buildAgentSessionKey: vi.fn().mockReturnValue("session-key"),
          resolveAgentRoute: vi
            .fn()
            .mockReturnValue({ agentId: "main", sessionKey: "s", mainSessionKey: "m" }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/t.json"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatInboundEnvelope: vi.fn().mockImplementation((p: { body: string }) => p.body),
          formatAgentEnvelope: vi.fn().mockImplementation((p: { body: string }) => p.body),
          finalizeInboundContext: vi.fn().mockImplementation((ctx: unknown) => ctx),
          resolveHumanDelayConfig: vi.fn().mockReturnValue(undefined),
          createReplyDispatcherWithTyping: vi
            .fn()
            .mockImplementation(
              (options: {
                deliver: (p: { text?: string }) => Promise<void>;
                onReplyStart: () => Promise<void>;
              }) => {
                deliverCallback = options.deliver;
                return {
                  dispatcher: { getQueuedCounts: () => ({ final: 0 }) },
                  replyOptions: { onReplyStart: options.onReplyStart },
                  markDispatchIdle: vi.fn(),
                };
              },
            ),
          createReplyPrefixOptions: vi.fn().mockReturnValue({}),
        },
        commands: { shouldHandleTextCommands: vi.fn().mockReturnValue(true) },
        mentions: {
          buildMentionRegexes: vi.fn().mockReturnValue([]),
          matchesMentionPatterns: vi.fn().mockReturnValue(false),
        },
        text: {
          hasControlCommand: vi.fn().mockReturnValue(false),
          resolveMarkdownTableMode: vi.fn().mockReturnValue("code"),
          resolveTextChunkLimit: vi.fn().mockReturnValue(4000),
          resolveChunkMode: vi.fn().mockReturnValue("length"),
          chunkMarkdownTextWithMode: vi.fn().mockReturnValue(["chunk"]),
          convertMarkdownTables: vi.fn().mockImplementation((t: string) => t),
        },
      },
      system: { enqueueSystemEvent: vi.fn() },
    } as any;

    setMatrixRuntime(core);

    const client = {
      getUserId: vi.fn().mockResolvedValue("@bot:matrix.org"),
      setTyping: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue("ev"),
      resolveRoom: vi.fn().mockImplementation((id: string) => id),
    } as any;

    const handler = createMatrixRoomMessageHandler({
      client,
      core,
      cfg: {} as any,
      runtime: { error: vi.fn() } as any,
      logger: { info: vi.fn(), warn: vi.fn() } as any,
      logVerboseMessage: vi.fn(),
      allowFrom: [],
      roomsConfig: undefined,
      groupPolicy: "open",
      replyToMode: "first",
      threadReplies: "inbound",
      dmEnabled: true,
      dmPolicy: "open",
      textLimit: 4000,
      mediaMaxBytes: 5242880,
      startupMs: Date.now(),
      startupGraceMs: 60000,
      directTracker: { isDirectMessage: vi.fn().mockResolvedValue(true) },
      getRoomInfo: vi.fn().mockResolvedValue({ name: "R", altAliases: [] }),
      getMemberDisplayName: vi.fn().mockResolvedValue("U"),
      historyLimit: 0,
      groupHistories: new Map(),
    });

    const event = {
      type: EventType.RoomMessage,
      event_id: "$1",
      sender: "@u:m.o",
      content: { msgtype: "m.text", body: "h" },
      origin_server_ts: Date.now(),
    } as any;

    await handler("!r:id", event);
    expect(core.channel.reply.createReplyDispatcherWithTyping).toHaveBeenCalled();

    // Trigger a block delivery and verify re-typing
    if (deliverCallback) {
      await deliverCallback({ text: "block" });
    }
    expect(mockOnReplyStart).toHaveBeenCalled();
  });
});
