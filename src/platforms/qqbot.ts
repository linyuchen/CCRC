import WebSocket, { type RawData } from "ws";
import type { QQBotConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type {
  Attachment,
  InboundHandler,
  InboundMessage,
  PlatformAdapter,
  ReplyTarget,
  SendOptions,
} from "./types.js";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_PRODUCTION = "https://api.sgroup.qq.com";
const API_SANDBOX = "https://sandbox.api.sgroup.qq.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_MESSAGE_CODEPOINTS = 1_900;
const MAX_RECONNECT_DELAY_MS = 60_000;
const OLD_MESSAGE_MS = 10 * 60_000;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

interface QQAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
}

interface GroupMessageEvent {
  id?: string;
  group_openid?: string;
  content?: string;
  timestamp?: string;
  attachments?: QQAttachment[];
  author?: { member_openid?: string };
}

interface C2CMessageEvent {
  id?: string;
  content?: string;
  timestamp?: string;
  attachments?: QQAttachment[];
  author?: { user_openid?: string };
}

interface InteractionEvent {
  id?: string;
  group_openid?: string;
  group_member_openid?: string;
  user_openid?: string;
  chat_type?: number;
  data?: {
    resolved?: {
      button_data?: string;
    };
  };
}

export class QQBotAdapter implements PlatformAdapter {
  readonly type = "qqbot";
  readonly id: string;

  private handler?: InboundHandler;
  private socket: WebSocket | undefined;
  private stopped = true;
  private connecting: Promise<void> | undefined;
  private reconnecting: Promise<void> | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatInterval = 41_250;
  private heartbeatAcknowledged = true;
  private sequence: number | null = null;
  private gatewaySessionId = "";
  private token = "";
  private tokenExpiresAt = 0;
  private refreshingToken: Promise<string> | undefined;
  private readonly seenMessages = new Map<string, number>();
  private readonly messageSequences = new Map<
    string,
    { value: number; createdAt: number }
  >();

  constructor(
    private readonly config: QQBotConfig,
    private readonly logger: Logger,
  ) {
    this.id = config.id;
  }

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;
    try {
      await this.connect();
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(1000, "broker stopping");
  }

  async send(
    target: ReplyTarget,
    text: string,
    options?: SendOptions,
  ): Promise<void> {
    const messageType = target.context.messageType;
    const destination =
      messageType === "group"
        ? `/v2/groups/${encodeURIComponent(target.context.groupOpenId ?? "")}/messages`
        : `/v2/users/${encodeURIComponent(target.context.userOpenId ?? "")}/messages`;

    if (!target.context.groupOpenId && !target.context.userOpenId) {
      throw new Error("QQ reply target has no destination");
    }

    const chunks = splitMessage(text, MAX_MESSAGE_CODEPOINTS);
    for (const [index, chunk] of chunks.entries()) {
      const body: Record<string, unknown> = this.config.markdown
        ? { markdown: { content: chunk }, msg_type: 2 }
        : { content: chunk, msg_type: 0 };
      if (options?.buttons && index === chunks.length - 1) {
        body.keyboard = qqKeyboard(options.buttons);
      }
      if (target.messageId) {
        body.msg_id = target.messageId;
        body.msg_seq = this.nextMessageSequence(target.messageId);
      }
      await this.apiRequest("POST", destination, body);
    }
    this.logger.info("sent QQ reply", {
      messageType,
      conversationId: target.conversationId,
      chunks: chunks.length,
    });
  }

  private get apiBase(): string {
    return this.config.sandbox ? API_SANDBOX : API_PRODUCTION;
  }

  private async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openGateway().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openGateway(): Promise<void> {
    const token = await this.getAccessToken();
    const gateway = await this.apiRequest<{ url: string }>(
      "GET",
      "/gateway/bot",
    );
    if (!gateway.url)
      throw new Error("QQ gateway response did not include a URL");

    const socket = new WebSocket(gateway.url, { handshakeTimeout: 15_000 });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const startupTimer = setTimeout(() => {
        reject(new Error("timed out waiting for QQ gateway READY"));
        socket.close();
      }, 20_000);

      socket.on("message", (raw: RawData) => {
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(raw.toString()) as GatewayPayload;
        } catch (error) {
          this.logger.warn("ignored malformed QQ gateway payload", {
            error: String(error),
          });
          return;
        }

        if (typeof payload.s === "number") this.sequence = payload.s;

        if (payload.op === OP_HELLO) {
          const hello = payload.d as
            { heartbeat_interval?: number } | undefined;
          this.heartbeatInterval = hello?.heartbeat_interval ?? 41_250;
          this.heartbeatAcknowledged = true;
          const authentication = this.gatewaySessionId
            ? {
                op: OP_RESUME,
                d: {
                  token: `QQBot ${token}`,
                  session_id: this.gatewaySessionId,
                  seq: this.sequence,
                },
              }
            : {
                op: OP_IDENTIFY,
                d: {
                  token: `QQBot ${token}`,
                  intents: this.config.intents,
                  shard: [0, 1],
                },
              };
          socket.send(JSON.stringify(authentication));
          return;
        }

        if (payload.op === OP_HEARTBEAT_ACK) {
          this.heartbeatAcknowledged = true;
          return;
        }

        if (payload.op === OP_HEARTBEAT) {
          this.sendHeartbeat(socket);
          return;
        }

        if (payload.op === OP_RECONNECT) {
          socket.close(4000, "QQ gateway requested reconnect");
          return;
        }
        if (payload.op === OP_INVALID_SESSION) {
          if (payload.d !== true) {
            this.gatewaySessionId = "";
            this.sequence = null;
          }
          socket.close(4000, "QQ gateway rejected the session");
          return;
        }

        if (payload.op !== OP_DISPATCH) return;
        if (payload.t === "READY") {
          const readyPayload = payload.d as { session_id?: string } | undefined;
          this.gatewaySessionId = readyPayload?.session_id ?? "";
          ready = true;
          clearTimeout(startupTimer);
          this.startHeartbeat(socket);
          this.logger.info("QQ gateway connected");
          resolve();
          return;
        }
        if (payload.t === "RESUMED") {
          ready = true;
          clearTimeout(startupTimer);
          this.startHeartbeat(socket);
          this.logger.info("QQ gateway session resumed");
          resolve();
          return;
        }

        if (payload.t === "GROUP_AT_MESSAGE_CREATE") {
          void this.handleGroupMessage(payload.d as GroupMessageEvent);
        } else if (payload.t === "C2C_MESSAGE_CREATE") {
          void this.handleC2CMessage(payload.d as C2CMessageEvent);
        } else if (payload.t === "INTERACTION_CREATE") {
          void this.handleInteraction(payload.d as InteractionEvent);
        }
      });

      socket.once("error", (error) => {
        if (!ready) {
          clearTimeout(startupTimer);
          reject(error);
        } else {
          this.logger.warn("QQ gateway websocket error", {
            error: error.message,
          });
        }
      });

      socket.once("close", (code, reason) => {
        clearTimeout(startupTimer);
        this.clearHeartbeat();
        if (this.socket === socket) this.socket = undefined;
        if (!ready)
          reject(
            new Error(
              `QQ gateway closed before READY (${code}: ${reason.toString()})`,
            ),
          );
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = (async () => {
      let delay = 1_000;
      while (!this.stopped) {
        await new Promise((resolve) =>
          setTimeout(resolve, delay + Math.floor(Math.random() * 500)),
        );
        try {
          await this.connect();
          return;
        } catch (error) {
          this.logger.warn("QQ gateway reconnect failed", {
            delayMs: delay,
            error: String(error),
          });
          delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        }
      }
    })().finally(() => {
      this.reconnecting = undefined;
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (!this.heartbeatAcknowledged) {
        this.logger.warn("QQ heartbeat was not acknowledged; reconnecting");
        socket.close(4000, "heartbeat timeout");
        return;
      }
      this.heartbeatAcknowledged = false;
      this.sendHeartbeat(socket);
    }, this.heartbeatInterval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.sequence }));
    }
  }

  private async handleGroupMessage(event: GroupMessageEvent): Promise<void> {
    const messageId = event.id?.trim();
    const groupOpenId = event.group_openid?.trim();
    const senderId = event.author?.member_openid?.trim();
    if (!messageId || !groupOpenId || !senderId) return;
    this.logger.info("received QQ message", {
      eventType: "group",
      messageId,
      senderId,
      conversationId: groupOpenId,
    });
    if (!this.acceptMessage(messageId, senderId, groupOpenId, event.timestamp))
      return;

    const text = stripAtMention(event.content ?? "");
    const attachments = normalizeAttachments(event.attachments);
    // An image-only message carries no text but still has to reach the session.
    if (!text && !attachments) return;
    const conversationId = this.config.shareGroupSession
      ? `group:${groupOpenId}`
      : `group:${groupOpenId}:${senderId}`;
    await this.deliver({
      platform: this.id,
      conversationId,
      senderId,
      messageId,
      text,
      ...(attachments ? { attachments } : {}),
      receivedAt: parseTimestamp(event.timestamp),
      replyTarget: {
        conversationId,
        senderId,
        messageId,
        context: { messageType: "group", groupOpenId, userOpenId: senderId },
      },
    });
  }

  private async handleC2CMessage(event: C2CMessageEvent): Promise<void> {
    const messageId = event.id?.trim();
    const senderId = event.author?.user_openid?.trim();
    if (!messageId || !senderId) return;
    this.logger.info("received QQ message", {
      eventType: "c2c",
      messageId,
      senderId,
      conversationId: senderId,
    });
    if (!this.acceptMessage(messageId, senderId, senderId, event.timestamp))
      return;

    const text = (event.content ?? "").trim();
    const attachments = normalizeAttachments(event.attachments);
    if (!text && !attachments) return;
    const conversationId = `c2c:${senderId}`;
    await this.deliver({
      platform: this.id,
      conversationId,
      senderId,
      messageId,
      text,
      ...(attachments ? { attachments } : {}),
      receivedAt: parseTimestamp(event.timestamp),
      replyTarget: {
        conversationId,
        senderId,
        messageId,
        context: { messageType: "c2c", userOpenId: senderId },
      },
    });
  }

  private async handleInteraction(event: InteractionEvent): Promise<void> {
    const interactionId = event.id?.trim();
    const interactionData = event.data?.resolved?.button_data?.trim();
    const isGroup = event.chat_type === 1;
    const groupOpenId = event.group_openid?.trim();
    const senderId = (
      isGroup ? event.group_member_openid : event.user_openid
    )?.trim();
    if (
      !interactionId ||
      !interactionData ||
      !senderId ||
      (isGroup && !groupOpenId)
    )
      return;

    await this.apiRequest(
      "PUT",
      `/interactions/${encodeURIComponent(interactionId)}`,
      { code: 0 },
    ).catch((error) =>
      this.logger.warn("failed to acknowledge QQ button interaction", {
        interactionId,
        error: String(error),
      }),
    );

    const rawConversationId = isGroup ? (groupOpenId as string) : senderId;
    this.logger.info("received QQ button interaction", {
      interactionId,
      senderId,
      conversationId: rawConversationId,
    });
    if (!this.acceptMessage(interactionId, senderId, rawConversationId)) return;

    const conversationId = isGroup
      ? this.config.shareGroupSession
        ? `group:${groupOpenId}`
        : `group:${groupOpenId}:${senderId}`
      : `c2c:${senderId}`;
    await this.deliver({
      platform: this.id,
      conversationId,
      senderId,
      messageId: interactionId,
      text: "",
      interactionData,
      receivedAt: new Date(),
      replyTarget: {
        conversationId,
        senderId,
        context: isGroup
          ? {
              messageType: "group",
              groupOpenId: groupOpenId as string,
              userOpenId: senderId,
            }
          : { messageType: "c2c", userOpenId: senderId },
      },
    });
  }

  private acceptMessage(
    messageId: string,
    senderId: string,
    conversationId: string,
    timestamp?: string,
  ): boolean {
    const timestampMs = timestamp ? Date.parse(timestamp) : Date.now();
    if (
      Number.isFinite(timestampMs) &&
      Date.now() - timestampMs > OLD_MESSAGE_MS
    )
      return false;
    if (
      !this.config.allowedSenders.includes("*") &&
      !this.config.allowedSenders.includes(senderId)
    ) {
      this.logger.warn("blocked QQ sender", { senderId, conversationId });
      return false;
    }
    if (
      this.config.allowedConversations.length > 0 &&
      !this.config.allowedConversations.includes(conversationId)
    )
      return false;
    if (this.seenMessages.has(messageId)) return false;
    this.seenMessages.set(messageId, Date.now());
    this.purgeSeenMessages();
    return true;
  }

  private async deliver(message: InboundMessage): Promise<void> {
    try {
      await this.handler?.(message);
    } catch (error) {
      this.logger.error("failed to process QQ message", {
        messageId: message.messageId,
        error: String(error),
      });
    }
  }

  private purgeSeenMessages(): void {
    const oldestAllowed = Date.now() - 10 * 60_000;
    for (const [id, timestamp] of this.seenMessages) {
      if (timestamp < oldestAllowed || this.seenMessages.size > 2_000)
        this.seenMessages.delete(id);
    }
  }

  private nextMessageSequence(messageId: string): number {
    const now = Date.now();
    for (const [id, entry] of this.messageSequences) {
      if (now - entry.createdAt > 5 * 60_000) this.messageSequences.delete(id);
    }
    const entry = this.messageSequences.get(messageId) ?? {
      value: 0,
      createdAt: now,
    };
    entry.value += 1;
    this.messageSequences.set(messageId, entry);
    return entry.value;
  }

  private async getAccessToken(force = false): Promise<string> {
    if (
      !force &&
      this.token &&
      Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS
    )
      return this.token;
    if (this.refreshingToken) return this.refreshingToken;
    this.refreshingToken = (async () => {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: this.config.appId,
          clientSecret: this.config.appSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await response.text();
      if (!response.ok)
        throw new Error(
          `QQ token endpoint returned ${response.status}: ${raw}`,
        );
      const result = JSON.parse(raw) as {
        access_token?: string;
        expires_in?: string | number;
      };
      if (!result.access_token)
        throw new Error("QQ token endpoint returned an empty access_token");
      const expiresIn = Number(result.expires_in) || 7_200;
      this.token = result.access_token;
      this.tokenExpiresAt = Date.now() + expiresIn * 1_000;
      return this.token;
    })().finally(() => {
      this.refreshingToken = undefined;
    });
    return this.refreshingToken;
  }

  private async apiRequest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    retry = true,
  ): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await response.text();
    if (response.status === 401 && retry) {
      await this.getAccessToken(true);
      return this.apiRequest<T>(method, path, body, false);
    }
    if (!response.ok)
      throw new Error(
        `QQ API ${method} ${path} returned ${response.status}: ${raw}`,
      );
    return (raw ? JSON.parse(raw) : {}) as T;
  }
}

function stripAtMention(content: string): string {
  return content
    .trim()
    .replace(/^<@![^>]+>\s*/, "")
    .trim();
}

function normalizeAttachments(
  attachments?: QQAttachment[],
): Attachment[] | undefined {
  const normalized = (attachments ?? [])
    .filter((item) => Boolean(item.url))
    .map((item) => ({
      ...(item.filename ? { name: item.filename } : {}),
      url: item.url as string,
      ...(item.content_type ? { contentType: item.content_type } : {}),
    }));
  return normalized.length > 0 ? normalized : undefined;
}

function parseTimestamp(value?: string): Date {
  if (!value) return new Date();
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
}

export function splitMessage(text: string, limit: number): string[] {
  const points = [...text];
  if (points.length <= limit) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(offset + limit, points.length);
    if (end < points.length) {
      const slice = points.slice(offset, end).join("");
      const newline = slice.lastIndexOf("\n");
      if (newline > limit / 2)
        end = offset + [...slice.slice(0, newline + 1)].length;
    }
    chunks.push(points.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}

function qqKeyboard(buttonRows: NonNullable<SendOptions["buttons"]>): object {
  return {
    content: {
      rows: buttonRows.slice(0, 5).map((row) => ({
        buttons: row.slice(0, 5).map((button) => ({
          id: button.id,
          render_data: {
            label: button.label,
            visited_label: button.visitedLabel ?? "已选择",
            style: button.style ?? 1,
          },
          action: {
            type: 1,
            data: button.data,
            permission: { type: 2 },
            click_limit: 1,
          },
          group_id: "ccrc-choice",
        })),
      })),
    },
  };
}
