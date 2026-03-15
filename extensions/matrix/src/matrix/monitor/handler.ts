import type { LocationMessageEventContent, MatrixClient } from "@vector-im/matrix-bot-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_GROUP_HISTORY_LIMIT,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createScopedPairingAccess,
  createReplyPrefixOptions,
  createTypingCallbacks,
  dispatchReplyFromConfigWithSettledDispatcher,
  evaluateGroupRouteAccessForPolicy,
  formatAllowlistMatchMeta,
  logInboundDrop,
  logTypingFailure,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  type HistoryEntry,
  type PluginRuntime,
  type RuntimeEnv,
  type RuntimeLogger,
} from "openclaw/plugin-sdk/matrix";
import type { CoreConfig, MatrixRoomConfig, ReplyToMode } from "../../types.js";
import { fetchEventSummary } from "../actions/summary.js";
import {
  formatPollAsText,
  isPollStartType,
  parsePollStartContent,
  type PollStartContent,
} from "../poll-types.js";
import { reactMatrixMessage, sendMessageMatrix, sendTypingMatrix } from "../send.js";
import { enforceMatrixDirectMessageAccess, resolveMatrixAccessState } from "./access-policy.js";
import {
  normalizeMatrixAllowList,
  resolveMatrixAllowListMatch,
  resolveMatrixAllowListMatches,
} from "./allowlist.js";
import {
  resolveMatrixBodyForAgent,
  resolveMatrixInboundSenderLabel,
  resolveMatrixSenderUsername,
} from "./inbound-body.js";
import { resolveMatrixLocation, type MatrixLocationPayload } from "./location.js";
import { downloadMatrixMedia } from "./media.js";
import { resolveMentions } from "./mentions.js";
import { deliverMatrixReplies } from "./replies.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { resolveMatrixThreadRootId, resolveMatrixThreadTarget } from "./threads.js";
import type { MatrixRawEvent, RoomMessageEventContent } from "./types.js";
import { EventType, RelationType } from "./types.js";

export type MatrixMonitorHandlerParams = {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
  allowFrom: string[];
  roomsConfig: Record<string, MatrixRoomConfig> | undefined;
  groupPolicy: "open" | "allowlist" | "disabled";
  replyToMode: ReplyToMode;
  threadReplies: "off" | "inbound" | "always";
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  textLimit: number;
  mediaMaxBytes: number;
  startupMs: number;
  startupGraceMs: number;
  directTracker: {
    isDirectMessage: (params: {
      roomId: string;
      senderId: string;
      selfUserId: string;
    }) => Promise<boolean>;
  };
  getRoomInfo: (
    roomId: string,
  ) => Promise<{ name?: string; canonicalAlias?: string; altAliases: string[] }>;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  accountId?: string | null;
};

export function resolveMatrixBaseRouteSession(params: {
  buildAgentSessionKey: (params: {
    agentId: string;
    channel: string;
    accountId?: string | null;
    peer?: { kind: "direct" | "channel"; id: string } | null;
  }) => string;
  baseRoute: {
    agentId: string;
    sessionKey: string;
    mainSessionKey: string;
    matchedBy?: string;
  };
  isDirectMessage: boolean;
  roomId: string;
  accountId?: string | null;
}): { sessionKey: string; lastRoutePolicy: "main" | "session" } {
  const sessionKey =
    params.isDirectMessage && params.baseRoute.matchedBy === "binding.peer.parent"
      ? params.buildAgentSessionKey({
          agentId: params.baseRoute.agentId,
          channel: "matrix",
          accountId: params.accountId,
          peer: { kind: "channel", id: params.roomId },
        })
      : params.baseRoute.sessionKey;
  return {
    sessionKey,
    lastRoutePolicy: sessionKey === params.baseRoute.mainSessionKey ? "main" : "session",
  };
}

export function shouldOverrideMatrixDmToGroup(params: {
  isDirectMessage: boolean;
  roomConfigInfo?:
    | {
        config?: MatrixRoomConfig;
        allowed: boolean;
        matchSource?: string;
      }
    | undefined;
}): boolean {
  return (
    params.isDirectMessage === true &&
    params.roomConfigInfo?.config !== undefined &&
    params.roomConfigInfo.allowed === true &&
    params.roomConfigInfo.matchSource === "direct"
  );
}

export function createMatrixRoomMessageHandler(params: MatrixMonitorHandlerParams) {
  const {
    client,
    core,
    cfg,
    runtime,
    logger,
    logVerboseMessage,
    allowFrom,
    roomsConfig,
    groupPolicy,
    replyToMode,
    threadReplies,
    dmEnabled,
    dmPolicy,
    historyLimit,
    groupHistories,
    textLimit,
    mediaMaxBytes,
    startupMs,
    startupGraceMs,
    directTracker,
    getRoomInfo,
    getMemberDisplayName,
    accountId,
  } = params;
  const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const pairing = createScopedPairingAccess({
    core,
    channel: "matrix",
    accountId: resolvedAccountId,
  });

  return async (roomId: string, event: MatrixRawEvent) => {
    try {
      const eventType = event.type;
      if (eventType === EventType.RoomMessageEncrypted) {
        // Encrypted messages are decrypted automatically by @vector-im/matrix-bot-sdk with crypto enabled
        return;
      }

      const isPollEvent = isPollStartType(eventType);
      const locationContent = event.content as unknown as LocationMessageEventContent;
      const isLocationEvent =
        eventType === EventType.Location ||
        (eventType === EventType.RoomMessage && locationContent.msgtype === EventType.Location);
      if (eventType !== EventType.RoomMessage && !isPollEvent && !isLocationEvent) {
        logVerboseMessage(`matrix: drop room=${roomId} type=${eventType} reason=not-message-event`);
        return;
      }
      logVerboseMessage(
        `matrix: room.message recv room=${roomId} type=${eventType} id=${event.event_id ?? "unknown"}`,
      );
      if (event.unsigned?.redacted_because) {
        logVerboseMessage(`matrix: drop room=${roomId} type=${eventType} reason=redacted`);
        return;
      }
      const senderId = event.sender;
      if (!senderId) {
        logVerboseMessage(`matrix: drop room=${roomId} type=${eventType} reason=no-sender`);
        return;
      }
      const selfUserId = await client.getUserId();
      if (senderId === selfUserId) {
        logVerboseMessage(`matrix: drop room=${roomId} type=${eventType} reason=self-message`);
        return;
      }
      const eventTs = event.origin_server_ts;
      const eventAge = event.unsigned?.age;
      const isHistorical =
        (typeof eventTs === "number" && eventTs < startupMs - startupGraceMs) ||
        (typeof eventTs !== "number" && typeof eventAge === "number" && eventAge > startupGraceMs);

      const roomInfo = await getRoomInfo(roomId);
      const roomName = roomInfo.name;
      const roomAliases = [roomInfo.canonicalAlias ?? "", ...roomInfo.altAliases].filter(Boolean);

      let content = event.content as unknown as RoomMessageEventContent;
      if (isPollEvent) {
        const pollStartContent = event.content as unknown as PollStartContent;
        const pollSummary = parsePollStartContent(pollStartContent);
        if (pollSummary) {
          pollSummary.eventId = event.event_id ?? "";
          pollSummary.roomId = roomId;
          pollSummary.sender = senderId;
          const senderDisplayName = await getMemberDisplayName(roomId, senderId);
          pollSummary.senderName = senderDisplayName;
          const pollText = formatPollAsText(pollSummary);
          content = {
            msgtype: "m.text",
            body: pollText,
          } as unknown as RoomMessageEventContent;
        } else {
          return;
        }
      }

      const locationPayload: MatrixLocationPayload | null = resolveMatrixLocation({
        eventType,
        content: content as LocationMessageEventContent,
      });

      const relates = content["m.relates_to"];
      if (relates && "rel_type" in relates) {
        if (relates.rel_type === RelationType.Replace) {
          return;
        }
      }

      let isDirectMessage = await directTracker.isDirectMessage({
        roomId,
        senderId,
        selfUserId,
      });

      // Resolve room config early so explicitly configured rooms can override DM classification.
      // This ensures rooms in the groups config are always treated as groups regardless of
      // member count or protocol-level DM flags. Only explicit matches (not wildcards) trigger
      // the override to avoid breaking DM routing when a wildcard entry exists. (See #9106)
      const roomConfigInfo = resolveMatrixRoomConfig({
        rooms: roomsConfig,
        roomId,
        aliases: roomAliases,
        name: roomName,
      });
      if (shouldOverrideMatrixDmToGroup({ isDirectMessage, roomConfigInfo })) {
        logVerboseMessage(
          `matrix: overriding DM to group for configured room=${roomId} (${roomConfigInfo.matchKey})`,
        );
        isDirectMessage = false;
      }

      const isRoom = !isDirectMessage;

      if (isRoom && groupPolicy === "disabled") {
        return;
      }
      // Only expose room config for confirmed group rooms. DMs should never inherit
      // group settings (skills, systemPrompt, autoReply) even when a wildcard entry exists.
      const roomConfig = isRoom ? roomConfigInfo?.config : undefined;
      const roomMatchMeta = roomConfigInfo
        ? `matchKey=${roomConfigInfo.matchKey ?? "none"} matchSource=${
            roomConfigInfo.matchSource ?? "none"
          }`
        : "matchKey=none matchSource=none";

      if (isRoom) {
        const routeAccess = evaluateGroupRouteAccessForPolicy({
          groupPolicy,
          routeAllowlistConfigured: Boolean(roomConfigInfo?.allowlistConfigured),
          routeMatched: Boolean(roomConfig),
          routeEnabled: roomConfigInfo?.allowed ?? true,
        });
        if (!routeAccess.allowed) {
          if (routeAccess.reason === "route_disabled") {
            logVerboseMessage(`matrix: room disabled room=${roomId} (${roomMatchMeta})`);
          } else if (routeAccess.reason === "empty_allowlist") {
            logVerboseMessage(`matrix: drop room message (no allowlist, ${roomMatchMeta})`);
          } else if (routeAccess.reason === "route_not_allowlisted") {
            logVerboseMessage(`matrix: drop room message (not in allowlist, ${roomMatchMeta})`);
          }
          return;
        }
      }

      const senderName = await getMemberDisplayName(roomId, senderId);
      const senderUsername = resolveMatrixSenderUsername(senderId);
      const senderLabel = resolveMatrixInboundSenderLabel({
        senderName,
        senderId,
        senderUsername,
      });
      const groupAllowFrom = cfg.channels?.matrix?.groupAllowFrom ?? [];
      const { access, effectiveAllowFrom, effectiveGroupAllowFrom, groupAllowConfigured } =
        await resolveMatrixAccessState({
          isDirectMessage,
          resolvedAccountId,
          dmPolicy,
          groupPolicy,
          allowFrom,
          groupAllowFrom,
          senderId,
          readStoreForDmPolicy: pairing.readStoreForDmPolicy,
        });

      if (isDirectMessage) {
        const allowedDirectMessage = await enforceMatrixDirectMessageAccess({
          dmEnabled,
          dmPolicy,
          accessDecision: access.decision,
          senderId,
          senderName,
          effectiveAllowFrom,
          upsertPairingRequest: pairing.upsertPairingRequest,
          sendPairingReply: async (text) => {
            await sendMessageMatrix(`room:${roomId}`, text, { client });
          },
          logVerboseMessage,
        });
        if (!allowedDirectMessage) {
          logVerboseMessage(`matrix: drop room=${roomId} reason=dm-access-denied`);
          return;
        }
      }

      const roomUsers = roomConfig?.users ?? [];
      if (isRoom && roomUsers.length > 0) {
        const userMatch = resolveMatrixAllowListMatch({
          allowList: normalizeMatrixAllowList(roomUsers),
          userId: senderId,
        });
        if (!userMatch.allowed) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (room users allowlist, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              userMatch,
            )})`,
          );
          return;
        }
      }
      if (isRoom && roomUsers.length === 0 && groupAllowConfigured && access.decision !== "allow") {
        const groupAllowMatch = resolveMatrixAllowListMatch({
          allowList: effectiveGroupAllowFrom,
          userId: senderId,
        });
        if (!groupAllowMatch.allowed) {
          logVerboseMessage(
            `matrix: blocked sender ${senderId} (groupAllowFrom, ${roomMatchMeta}, ${formatAllowlistMatchMeta(
              groupAllowMatch,
            )})`,
          );
          return;
        }
      }
      if (isRoom) {
        logVerboseMessage(`matrix: allow room ${roomId} (${roomMatchMeta})`);
      }

      const rawBody =
        locationPayload?.text ?? (typeof content.body === "string" ? content.body.trim() : "");
      if (!rawBody && !media) {
        logVerboseMessage(`matrix: drop room=${roomId} reason=empty-body`);
        return;
      }
      let media: {
        path: string;
        contentType?: string;
        placeholder: string;
      } | null = null;
      const contentUrl =
        "url" in content && typeof content.url === "string" ? content.url : undefined;
      const contentFile =
        "file" in content && content.file && typeof content.file === "object"
          ? content.file
          : undefined;
      const mediaUrl = contentUrl ?? contentFile?.url;

      if (!isHistorical && (rawBody || mediaUrl)) {
        const contentInfo =
          "info" in content && content.info && typeof content.info === "object"
            ? (content.info as { mimetype?: string; size?: number })
            : undefined;
        const contentType = contentInfo?.mimetype;
        const contentSize = typeof contentInfo?.size === "number" ? contentInfo.size : undefined;
        if (mediaUrl?.startsWith("mxc://")) {
          try {
            media = await downloadMatrixMedia({
              client,
              mxcUrl: mediaUrl,
              contentType,
              sizeBytes: contentSize,
              maxBytes: mediaMaxBytes,
              file: contentFile,
            });
          } catch (err) {
            logVerboseMessage(`matrix: media download failed: ${String(err)}`);
          }
        }
      }

      const bodyText = rawBody || media?.placeholder || "";
      if (!bodyText) {
        return;
      }

      const messageId = event.event_id ?? "";
      const replyToEventId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
      const threadRootId = resolveMatrixThreadRootId({ event, content });

      const baseRoute = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "matrix",
        accountId,
        peer: {
          kind: isDirectMessage ? "direct" : "channel",
          id: isDirectMessage ? senderId : roomId,
        },
        // For DMs, pass roomId as parentPeer so the conversation is bindable by room ID
        // while preserving DM trust semantics (secure 1:1, no group restrictions).
        parentPeer: isDirectMessage ? { kind: "channel", id: roomId } : undefined,
      });
      const baseRouteSession = resolveMatrixBaseRouteSession({
        buildAgentSessionKey: core.channel.routing.buildAgentSessionKey,
        baseRoute,
        isDirectMessage,
        roomId,
        accountId,
      });

      const historyKey = isRoom ? roomId : senderId;
      // Resolve agent-specific history limit if configured
      const agentConfig = baseRoute.agentId
        ? (cfg.agents?.list?.find((a: any) => a.id === baseRoute.agentId) as any)
        : undefined;
      const agentHistoryLimit =
        agentConfig?.groupChat?.historyLimit ??
        (cfg.agents as any)?.defaults?.groupChat?.historyLimit;
      const finalHistoryLimit = Math.max(0, agentHistoryLimit ?? historyLimit);

      const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, baseRoute.agentId);
      const { wasMentioned, hasExplicitMention } = resolveMentions({
        content,
        userId: selfUserId,
        text: bodyText,
        mentionRegexes,
      });

      const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
        cfg,
        surface: "matrix",
      });
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const senderAllowedForCommands = resolveMatrixAllowListMatches({
        allowList: effectiveAllowFrom,
        userId: senderId,
      });
      const senderAllowedForGroup = groupAllowConfigured
        ? resolveMatrixAllowListMatches({
            allowList: effectiveGroupAllowFrom,
            userId: senderId,
          })
        : false;
      const senderAllowedForRoomUsers =
        isRoom && roomUsers.length > 0
          ? resolveMatrixAllowListMatches({
              allowList: normalizeMatrixAllowList(roomUsers),
              userId: senderId,
            })
          : false;
      const hasControlCommandInMessage = core.channel.text.hasControlCommand(bodyText, cfg);
      const commandGate = resolveControlCommandGate({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
          { configured: roomUsers.length > 0, allowed: senderAllowedForRoomUsers },
          { configured: groupAllowConfigured, allowed: senderAllowedForGroup },
        ],
        allowTextCommands,
        hasControlCommand: hasControlCommandInMessage,
      });
      const commandAuthorized = commandGate.commandAuthorized;
      if (isRoom && commandGate.shouldBlock) {
        logInboundDrop({
          log: logVerboseMessage,
          channel: "matrix",
          reason: "control command (unauthorized)",
          target: senderId,
        });
        return;
      }

      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const envelopeFrom = isDirectMessage ? senderName : (roomName ?? roomId);
      const textWithId = threadRootId
        ? `${bodyText}\n[matrix event id: ${messageId} room: ${roomId} thread: ${threadRootId}]`
        : `${bodyText}\n[matrix event id: ${messageId} room: ${roomId}]`;
      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: baseRoute.agentId,
      });
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: baseRoute.sessionKey, // threadRootId handled in route.sessionKey below
      });

      const body = core.channel.reply.formatInboundEnvelope({
        channel: "Matrix",
        from: envelopeFrom,
        timestamp: eventTs ?? undefined,
        previousTimestamp,
        envelope: envelopeOptions,
        body: textWithId,
        chatType: isDirectMessage ? "direct" : "channel",
        senderLabel,
      });

      let combinedBody = body;
      const historyEntries = groupHistories.get(historyKey) ?? [];

      const inboundHistory =
        isRoom && finalHistoryLimit > 0
          ? historyEntries.map((h) => ({
              sender: h.sender,
              body: h.body,
              timestamp: h.timestamp,
            }))
          : undefined;

      if (isRoom && finalHistoryLimit > 0) {
        logger.debug(
          `matrix: recording message to buffer room=${roomId} id=${messageId} sender=${senderId} limit=${finalHistoryLimit} agent=${baseRoute.agentId} isHistorical=${isHistorical}`,
        );
        recordPendingHistoryEntryIfEnabled({
          historyMap: groupHistories,
          historyKey,
          limit: finalHistoryLimit,
          entry: {
            body: bodyText,
            sender: senderLabel,
            timestamp: eventTs ?? undefined,
            messageId,
          },
        });
      }

      if (isHistorical) {
        return;
      }

      if (isRoom && finalHistoryLimit > 0) {
        logger.debug(
          `matrix: building context with ${inboundHistory?.length ?? 0} history entries room=${roomId}`,
        );
        combinedBody = buildPendingHistoryContextFromMap({
          historyMap: groupHistories,
          historyKey,
          limit: finalHistoryLimit,
          currentMessage: body,
          formatEntry: (h) =>
            core.channel.reply.formatInboundEnvelope({
              channel: "Matrix",
              from: envelopeFrom,
              timestamp: h.timestamp,
              body:
                h.body + (h.messageId ? `\n[matrix event id: ${h.messageId} room: ${roomId}]` : ""),
              chatType: "channel",
              senderLabel: h.sender,
              envelope: envelopeOptions,
            }),
        });
      }

      const shouldRequireMention = isRoom
        ? roomConfig?.autoReply === true
          ? false
          : roomConfig?.autoReply === false
            ? true
            : typeof roomConfig?.requireMention === "boolean"
              ? roomConfig?.requireMention
              : true
        : false;

      const shouldBypassMention =
        allowTextCommands &&
        isRoom &&
        shouldRequireMention &&
        !wasMentioned &&
        !hasExplicitMention &&
        commandAuthorized &&
        hasControlCommandInMessage;

      const canDetectMention = mentionRegexes.length > 0 || hasExplicitMention;

      if (isRoom && shouldRequireMention && !wasMentioned && !shouldBypassMention) {
        logger.debug(
          `skipping room message room=${roomId} reason=no-mention agent=${baseRoute.agentId}`,
        );
        return;
      }

      const threadTarget = resolveMatrixThreadTarget({
        threadReplies,
        messageId,
        threadRootId,
        isThreadRoot: false, // @vector-im/matrix-bot-sdk doesn't have this info readily available
      });

      const route = {
        ...baseRoute,
        lastRoutePolicy: baseRouteSession.lastRoutePolicy,
        sessionKey: threadRootId
          ? `${baseRouteSession.sessionKey}:thread:${threadRootId}`
          : baseRouteSession.sessionKey,
      };

      let threadStarterBody: string | undefined;
      let threadLabel: string | undefined;
      let parentSessionKey: string | undefined;

      if (threadRootId) {
        const existingSession = core.channel.session.readSessionUpdatedAt({
          storePath,
          sessionKey: route.sessionKey,
        });

        if (existingSession === undefined) {
          try {
            const rootEvent = await fetchEventSummary(client, roomId, threadRootId);
            if (rootEvent?.body) {
              const rootSenderName = rootEvent.sender
                ? await getMemberDisplayName(roomId, rootEvent.sender)
                : undefined;

              threadStarterBody = core.channel.reply.formatAgentEnvelope({
                channel: "Matrix",
                from: rootSenderName ?? rootEvent.sender ?? "Unknown",
                timestamp: rootEvent.timestamp,
                envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
                body: rootEvent.body,
              });

              threadLabel = `Matrix thread in ${roomName ?? roomId}`;
              parentSessionKey = baseRoute.sessionKey;
            }
          } catch (err) {
            logVerboseMessage(
              `matrix: failed to fetch thread root ${threadRootId}: ${String(err)}`,
            );
          }
        }
      }

      const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || undefined;
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: combinedBody,
        InboundHistory: inboundHistory,
        BodyForAgent: resolveMatrixBodyForAgent({
          isDirectMessage,
          bodyText,
          senderLabel,
        }),
        RawBody: bodyText,
        CommandBody: bodyText,
        From: isDirectMessage ? `matrix:${senderId}` : `matrix:channel:${roomId}`,
        To: `room:${roomId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: threadRootId ? "thread" : isDirectMessage ? "direct" : "channel",
        ConversationLabel: envelopeFrom,
        SenderName: senderName,
        SenderId: senderId,
        SenderUsername: senderUsername,
        GroupSubject: isRoom ? (roomName ?? roomId) : undefined,
        GroupChannel: isRoom ? (roomInfo.canonicalAlias ?? roomId) : undefined,
        GroupSystemPrompt: isRoom ? groupSystemPrompt : undefined,
        Provider: "matrix" as const,
        Surface: "matrix" as const,
        WasMentioned: isRoom ? wasMentioned : undefined,
        MessageSid: messageId,
        ReplyToId: threadTarget ? undefined : (replyToEventId ?? undefined),
        MessageThreadId: threadTarget,
        Timestamp: eventTs ?? undefined,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        ...locationPayload?.context,
        CommandAuthorized: commandAuthorized,
        CommandSource: "text" as const,
        OriginatingChannel: "matrix" as const,
        OriginatingTo: `room:${roomId}`,
        ThreadStarterBody: threadStarterBody,
        ThreadLabel: threadLabel,
        ParentSessionKey: parentSessionKey,
      });

      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        updateLastRoute: isDirectMessage
          ? {
              sessionKey: route.mainSessionKey,
              channel: "matrix",
              to: `room:${roomId}`,
              accountId: route.accountId,
            }
          : undefined,
        onRecordError: (err) => {
          logger.warn("failed updating session meta", {
            error: String(err),
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
          });
        },
      });

      const preview = bodyText.slice(0, 200).replace(/\n/g, "\\n");
      logVerboseMessage(`matrix inbound: room=${roomId} from=${senderId} preview="${preview}"`);

      const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
      const ackScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      const shouldAckReaction = () =>
        Boolean(
          ackReaction &&
          core.channel.reactions.shouldAckReaction({
            scope: ackScope,
            isDirect: isDirectMessage,
            isGroup: isRoom,
            isMentionableGroup: isRoom,
            requireMention: Boolean(shouldRequireMention),
            canDetectMention,
            effectiveWasMentioned: wasMentioned || shouldBypassMention,
            shouldBypassMention,
          }),
        );
      if (shouldAckReaction() && messageId) {
        reactMatrixMessage(roomId, messageId, ackReaction, client).catch((err) => {
          logVerboseMessage(`matrix react failed for room ${roomId}: ${String(err)}`);
        });
      }

      const replyTarget = ctxPayload.To;
      if (!replyTarget) {
        runtime.error?.("matrix: missing reply target");
        return;
      }

      let didSendReply = false;
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "matrix",
        accountId: route.accountId,
      });
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: route.agentId,
        channel: "matrix",
        accountId: route.accountId,
      });
      const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);
      const typingCallbacks = createTypingCallbacks({
        start: () => sendTypingMatrix(roomId, true, undefined, client),
        stop: () => sendTypingMatrix(roomId, false, undefined, client),
        onStartError: (err) => {
          logTypingFailure({
            log: logVerboseMessage,
            channel: "matrix",
            action: "start",
            target: roomId,
            error: err,
          });
        },
        onStopError: (err) => {
          logTypingFailure({
            log: logVerboseMessage,
            channel: "matrix",
            action: "stop",
            target: roomId,
            error: err,
          });
        },
      });
      let accumulatedBlockText = "";

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          ...prefixOptions,
          humanDelay,
          typingCallbacks,
          deliver: async (payload) => {
            if (payload.text) {
              accumulatedBlockText += payload.text;
            }
            await deliverMatrixReplies({
              replies: [payload],
              roomId,
              client,
              runtime,
              textLimit,
              replyToMode,
              threadId: threadTarget,
              accountId: route.accountId,
              tableMode,
            });
            didSendReply = true;
            // Matrix servers often clear typing status after a message is sent.
            // Re-signal typing immediately if we're still in the middle of a run.
            if (typingCallbacks?.onReplyStart) {
              await typingCallbacks.onReplyStart();
            }
          },
          onError: (err, info) => {
            runtime.error?.(`matrix ${info.kind} reply failed: ${String(err)}`);
          },
        });

      const channelCfg = cfg.channels?.matrix;
      const accountCfg =
        resolvedAccountId !== "default" ? channelCfg?.accounts?.[resolvedAccountId] : undefined;
      const effectiveBlockStreaming = accountCfg?.blockStreaming ?? channelCfg?.blockStreaming;

      const disableBlockStreaming =
        typeof effectiveBlockStreaming === "boolean" ? !effectiveBlockStreaming : undefined;

      const historySnapshotCount = groupHistories.get(historyKey)?.length ?? 0;

      const { queuedFinal, counts } = await dispatchReplyFromConfigWithSettledDispatcher({
        cfg,
        ctxPayload,
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        replyOptions: {
          ...replyOptions,
          skillFilter: roomConfig?.skills,
          onModelSelected,
          disableBlockStreaming,
        },
      });

      if (accumulatedBlockText.trim() && finalHistoryLimit > 0) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: groupHistories,
          historyKey,
          limit: finalHistoryLimit,
          entry: {
            role: "assistant",
            content: accumulatedBlockText.trim(),
            timestamp: Date.now(),
          },
        });
      }

      if (!queuedFinal) {
        return;
      }
      didSendReply = true;
      const finalCount = counts.final;

      if (isRoom && finalHistoryLimit > 0) {
        logger.debug(`matrix: clearing history after successful reply room=${roomId}`);
        clearHistoryEntriesIfEnabled({
          historyMap: groupHistories,
          historyKey,
          limit: finalHistoryLimit,
          count: historySnapshotCount,
        });
      }

      logVerboseMessage(
        `matrix: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
    } catch (err) {
      runtime.error?.(`matrix handler failed: ${String(err)}`);
    }
  };
}
