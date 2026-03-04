import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler history", () => {
  let mockCore: any;
  let mockLogger: any;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    mockClient = { getUserId: vi.fn().mockResolvedValue("@bot:matrix.org") };
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
          createReplyDispatcherWithTyping: vi.fn().mockReturnValue({
            dispatcher: {
              markComplete: vi.fn(),
              waitForIdle: vi.fn().mockResolvedValue(undefined),
              sendToolResult: vi.fn().mockReturnValue(true),
              sendBlockReply: vi.fn().mockReturnValue(true),
              sendFinalReply: vi.fn().mockReturnValue(true),
              getQueuedCounts: vi.fn().mockReturnValue({ tool: 0, block: 0, final: 1 }),
            },
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          }),
          withReplyDispatcher: vi
            .fn()
            .mockResolvedValue({ queuedFinal: true, counts: { final: 1 } }),
          dispatchReplyFromConfig: vi.fn().mockResolvedValue({ queuedFinal: true }),
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

  it("resolves historyLimit from agents.list and builds context", async () => {
    const groupHistories = new Map();
    const handler = createHandler({
      cfg: { agents: { list: [{ id: "test-agent", groupChat: { historyLimit: 5 } }] } } as any,
      groupHistories,
    });

    const event: MatrixRawEvent = {
      type: EventType.RoomMessage,
      event_id: "$msg1",
      sender: "@user:matrix.org",
      origin_server_ts: 2000000,
      content: { msgtype: "m.text", body: "@bot hello" },
    };

    await handler("!room:matrix.org", event);

    const infoCalls = mockLogger.debug.mock.calls.map((c) => c[0]);
    expect(infoCalls.some((c) => c.includes("limit=5") && c.includes("agent=test-agent"))).toBe(
      true,
    );
    expect(infoCalls.some((c) => c.includes("building context with 0 history entries"))).toBe(true);
    expect(infoCalls.some((c) => c.includes("clearing history after successful reply"))).toBe(true);
  });

  it("handles isHistorical messages by recording them and returning early", async () => {
    const groupHistories = new Map();
    const handler = createHandler({
      cfg: { agents: { list: [{ id: "test-agent", groupChat: { historyLimit: 5 } }] } } as any,
      groupHistories,
      startupMs: 5000000,
    });

    const event: MatrixRawEvent = {
      type: EventType.RoomMessage,
      event_id: "$old",
      sender: "@user:matrix.org",
      origin_server_ts: 2000000,
      content: { msgtype: "m.text", body: "past" },
    };

    await handler("!room:matrix.org", event);

    const infoCalls = mockLogger.debug.mock.calls.map((c) => c[0]);
    expect(
      infoCalls.some(
        (c) => c.includes("recording message to buffer") && c.includes("isHistorical=true"),
      ),
    ).toBe(true);
    expect(infoCalls.some((c) => c.includes("building context"))).toBe(false);
    expect(mockCore.channel.reply.finalizeInboundContext).not.toHaveBeenCalled();
  });

  function createHandler(params: any) {
    return createMatrixRoomMessageHandler({
      client: mockClient,
      core: mockCore,
      cfg: params.cfg,
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
      groupHistories: params.groupHistories,
      textLimit: 4000,
      mediaMaxBytes: 1024,
      startupMs: params.startupMs ?? 1000,
      startupGraceMs: 0,
      directTracker: { isDirectMessage: vi.fn().mockResolvedValue(false) } as any,
      getRoomInfo: vi.fn().mockImplementation(async () => ({ name: "Room", altAliases: [] })),
      getMemberDisplayName: vi.fn().mockResolvedValue("User"),
      accountId: "acc1",
    });
  }
});
