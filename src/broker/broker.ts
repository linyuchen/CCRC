import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { basename } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import type {
  ClaudeCodeRemoteControlConfig,
  PlatformConfig,
} from "../core/config.js";
import type { Logger } from "../core/logger.js";
import {
  clientMessageSchema,
  PROTOCOL_VERSION,
  parseWireMessage,
  type BrokerMessage,
  type ClientMessage,
} from "../core/protocol.js";
import type { ClaudeCodeRemoteControlPaths } from "../core/paths.js";
import { saveAttachments } from "./attachments.js";
import { createPlatformAdapter } from "../platforms/index.js";
import type {
  InboundMessage,
  MessageButton,
  PlatformAdapter,
  ReplyTarget,
  SendOptions,
} from "../platforms/types.js";
import { SessionRegistry } from "./session-registry.js";
import {
  loadState,
  saveState,
  type BrokerState,
  type PersistedOutputTarget,
} from "./state-store.js";

interface RouteRecord {
  id: string;
  sessionId: string;
  platformId: string;
  target: ReplyTarget;
  createdAt: number;
}

interface PendingPermission {
  sessionId: string;
  requestId: string;
  createdAt: number;
}

interface PlatformRuntime {
  adapter: PlatformAdapter;
  status: "starting" | "online" | "error" | "stopped";
  error?: string;
}

interface ExplicitReply {
  text: string;
  sentAt: number;
  outputTargetKey: string;
}

interface PendingChoice {
  sessionId: string;
  requestId: string;
  options: Array<{ label: string; description?: string | undefined }>;
  outputTargetKeys: Set<string>;
  multiSelect: boolean;
  selectedIndices: Set<number>;
  createdAt: number;
  resolve: (selection: ChoiceSelection) => void;
  reject: (error: Error) => void;
}

interface ChoiceSelection {
  selectedIndices: number[];
  labels: string[];
}

interface SessionDetails {
  title?: string | undefined;
  projectDir?: string | undefined;
}

export type PlatformFactory = (
  config: PlatformConfig,
  logger: Logger,
) => PlatformAdapter;

const PERMISSION_REPLY =
  /^\s*(y|yes|allow|允许|n|no|deny|拒绝)\s+([a-km-z]{5})\s*$/i;
const ROUTE_TTL_MS = 24 * 60 * 60_000;
const PERMISSION_TTL_MS = 30 * 60_000;
const CHOICE_TTL_MS = 30 * 60_000;
const REPLY_DEDUPE_MS = 60_000;
const HOOK_BODY_LIMIT = 2 * 1024 * 1024;
const assistantResponseSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  text: z.string().min(1),
  origin: z.enum(["external", "local"]),
  title: z.string().min(1).optional(),
  projectDir: z.string().min(1).optional(),
});
const choiceOptionSchema = z.object({
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1_000).optional(),
});
const askUserQuestionSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  projectDir: z.string().min(1).optional(),
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(4_000),
        header: z.string().trim().max(100).optional(),
        options: z.array(choiceOptionSchema).min(2).max(4),
        multiSelect: z.boolean().optional().default(false),
      }),
    )
    .min(1)
    .max(4),
});
const askUserQuestionCompletionSchema = z.object({
  sessionId: z.string().min(1),
  answers: z.record(z.string()).optional(),
});

export class Broker {
  private readonly server: HttpServer;
  private readonly websocketServer: WebSocketServer;
  private registry!: SessionRegistry;
  private readonly platforms = new Map<string, PlatformRuntime>();
  private readonly routes = new Map<string, RouteRecord>();
  private readonly outputTargets = new Map<string, PersistedOutputTarget>();
  private readonly explicitReplies = new Map<string, ExplicitReply>();
  private readonly mirroredMessages = new Map<string, number>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingChoices = new Map<string, PendingChoice>();
  private readonly sessionDetails = new Map<string, SessionDetails>();
  private stateWrite = Promise.resolve();
  private heartbeat: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(
    private readonly config: ClaudeCodeRemoteControlConfig,
    private readonly paths: ClaudeCodeRemoteControlPaths,
    private readonly token: string,
    private readonly logger: Logger,
    private readonly platformFactory: PlatformFactory = createPlatformAdapter,
  ) {
    this.server = createServer((request, response) =>
      this.handleHttp(request, response),
    );
    this.websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 1_048_576,
    });
  }

  async start(): Promise<void> {
    const state = await loadState(this.paths.state);
    this.registry = new SessionRegistry(state);
    for (const [key, outputTarget] of Object.entries(state.outputTargets)) {
      this.outputTargets.set(key, {
        ...outputTarget,
        target: withoutInboundMessageId(outputTarget.target),
      });
    }
    if (this.migrateLegacyOutputTargets(state)) this.persistState();
    this.installWebSocketServer();

    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(
        this.config.broker.port,
        this.config.broker.host,
        () => {
          this.server.off("error", reject);
          resolve();
        },
      );
    });

    this.heartbeat = setInterval(() => this.sweep(), 30_000);
    this.logger.info("broker listening", {
      host: this.config.broker.host,
      port: this.config.broker.port,
    });

    for (const platformConfig of this.config.platforms) {
      if (!platformConfig.enabled) continue;
      const logger = this.logger;
      const adapter = this.platformFactory(platformConfig, logger);
      const runtime: PlatformRuntime = { adapter, status: "starting" };
      this.platforms.set(adapter.id, runtime);
      try {
        await adapter.start((message) => this.handleInbound(adapter, message));
        runtime.status = "online";
      } catch (error) {
        runtime.status = "error";
        runtime.error = String(error);
        this.logger.error(
          "platform failed its initial connection; retries continue in background",
          {
            platform: adapter.id,
            error: String(error),
          },
        );
      }
    }

    if (this.platforms.size === 0) {
      this.logger.warn(
        "no platform adapters configured; sessions can connect but no external messages will arrive",
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;

    await Promise.allSettled(
      [...this.platforms.values()].map(async (runtime) => {
        await runtime.adapter.stop();
        runtime.status = "stopped";
      }),
    );
    for (const client of this.websocketServer.clients)
      client.close(1001, "broker stopping");
    for (const pending of this.pendingChoices.values())
      pending.reject(new Error("broker is stopping"));
    this.pendingChoices.clear();
    await new Promise<void>((resolve) =>
      this.websocketServer.close(() => resolve()),
    );
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.stateWrite.catch(() => undefined);
    await unlink(this.paths.pid).catch(() => undefined);
    this.logger.info("broker stopped");
  }

  status(): Record<string, unknown> {
    return {
      pid: process.pid,
      sessions: this.registry.list().map((session) => ({
        id: session.id,
        displayName: session.displayName,
        projectDir: session.projectDir,
        connectedAt: session.connectedAt.toISOString(),
      })),
      platforms: [...this.platforms.values()].map((runtime) => ({
        id: runtime.adapter.id,
        type: runtime.adapter.type,
        status: runtime.status,
        ...(runtime.error ? { error: runtime.error } : {}),
      })),
      mirrorLocalReplies: this.config.broker.mirrorLocalReplies,
      outputTargets: [...this.outputTargets.values()].map((outputTarget) => ({
        platform: outputTarget.platformId,
        conversationId: outputTarget.target.conversationId,
      })),
    };
  }

  private installWebSocketServer(): void {
    this.server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/channel" || !this.authorized(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (client) => {
        this.websocketServer.emit("connection", client, request);
      });
    });

    this.websocketServer.on("connection", (socket) => {
      const helloTimeout = setTimeout(
        () => socket.close(4002, "hello timeout"),
        10_000,
      );
      socket.on("message", (data) => {
        void this.handleClientMessage(socket, data)
          .then(() => {
            if (this.registry.forSocket(socket)) clearTimeout(helloTimeout);
          })
          .catch((error) => {
            this.logger.warn("invalid client message", {
              error: String(error),
            });
            this.sendSocket(socket, {
              type: "error",
              message: (error as Error).message,
            });
          });
      });
      socket.on("close", () => {
        clearTimeout(helloTimeout);
        const disconnected = this.registry.unregister(socket);
        if (disconnected)
          this.logger.info("Claude session disconnected", {
            sessionId: disconnected.metadata.id,
          });
      });
      socket.on("error", (error) =>
        this.logger.warn("channel client websocket error", {
          error: error.message,
        }),
      );
    });
  }

  private async handleClientMessage(
    socket: WebSocket,
    raw: WebSocket.RawData,
  ): Promise<void> {
    const message = clientMessageSchema.parse(parseWireMessage(raw));
    if (message.type === "hello") {
      const session = this.registry.register(socket, message.session);
      this.logger.info("Claude session connected", {
        sessionId: session.metadata.id,
        displayName: session.displayName,
        projectDir: session.metadata.projectDir,
      });
      this.sendSocket(socket, {
        type: "hello_ack",
        protocol: PROTOCOL_VERSION,
        sessionId: session.metadata.id,
        displayName: session.displayName,
      });
      return;
    }

    const session = this.registry.forSocket(socket);
    if (!session) throw new Error("hello must be the first client message");
    this.registry.touch(socket);

    if (message.type === "heartbeat") return;
    if (message.type === "reply") {
      await this.handleReply(session.metadata.id, socket, message);
      return;
    }
    if (message.type === "permission_request") {
      await this.handlePermissionRequest(session.metadata.id, message);
      return;
    }
    if (message.type === "choice_request") {
      await this.handleChoiceRequest(session.metadata.id, socket, message);
    }
  }

  private async handleReply(
    sessionId: string,
    socket: WebSocket,
    message: Extract<ClientMessage, { type: "reply" }>,
  ): Promise<void> {
    try {
      const route = this.routes.get(message.routeId);
      if (
        !route ||
        route.sessionId !== sessionId ||
        Date.now() - route.createdAt > ROUTE_TTL_MS
      ) {
        throw new Error(
          "reply route is missing, expired, or belongs to another session",
        );
      }
      const platform = this.platforms.get(route.platformId);
      if (!platform)
        throw new Error(`platform ${route.platformId} is unavailable`);
      await platform.adapter.send(
        route.target,
        message.text,
        message.attachments ? { attachments: message.attachments } : undefined,
      );
      this.explicitReplies.set(sessionId, {
        text: message.text,
        sentAt: Date.now(),
        outputTargetKey: outputTargetKey(route.platformId, route.target),
      });
      this.sendSocket(socket, {
        type: "ack",
        correlationId: message.correlationId,
        ok: true,
      });
    } catch (error) {
      this.sendSocket(socket, {
        type: "ack",
        correlationId: message.correlationId,
        ok: false,
        error: (error as Error).message,
      });
    }
  }

  private async handlePermissionRequest(
    sessionId: string,
    message: Extract<ClientMessage, { type: "permission_request" }>,
  ): Promise<void> {
    const preview = message.inputPreview.trim();
    const text = this.withSessionFooter(
      sessionId,
      [
        "## Claude 权限请求",
        `**工具：** ${escapeMarkdown(message.toolName)}`,
        `**说明：** ${message.description}`,
        preview ? `**参数：** \`${escapeMarkdownCode(preview)}\`` : "",
        `也可回复 \`yes ${message.requestId}\` 或 \`no ${message.requestId}\`。`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    const buttons: MessageButton[][] = [
      [
        {
          id: `allow-${message.requestId}`,
          label: "允许",
          visitedLabel: "已允许",
          style: 1,
          data: `ccrc:permission:allow:${message.requestId}`,
        },
        {
          id: `deny-${message.requestId}`,
          label: "拒绝",
          visitedLabel: "已拒绝",
          style: 0,
          data: `ccrc:permission:deny:${message.requestId}`,
        },
      ],
    ];
    const createdAt = Date.now();
    for (const key of this.outputTargets.keys()) {
      this.pendingPermissions.set(permissionKey(key, message.requestId), {
        sessionId,
        requestId: message.requestId,
        createdAt,
      });
    }
    const delivery = await this.sendToOutputTargets(text, {
      buttons,
    });
    for (const key of this.outputTargets.keys()) {
      if (delivery.delivered.has(key)) continue;
      this.pendingPermissions.delete(permissionKey(key, message.requestId));
    }
    if (delivery.delivered.size === 0) {
      this.logger.warn("cannot relay permission without an output target", {
        sessionId,
        requestId: message.requestId,
      });
    }
  }

  private async handleChoiceRequest(
    sessionId: string,
    socket: WebSocket,
    message: Extract<ClientMessage, { type: "choice_request" }>,
  ): Promise<void> {
    try {
      const answer = await this.waitForChoice({
        sessionId,
        requestId: message.requestId,
        question: message.question,
        options: message.options,
        multiSelect: false,
      });
      this.sendSocket(socket, {
        type: "choice_result",
        requestId: message.requestId,
        ok: true,
        selectedIndex: answer.selectedIndices[0],
        label: answer.labels[0],
      });
    } catch (error) {
      this.sendSocket(socket, {
        type: "choice_result",
        requestId: message.requestId,
        ok: false,
        error: (error as Error).message,
      });
    }
  }

  private async waitForChoice(input: {
    sessionId: string;
    requestId: string;
    question: string;
    header?: string | undefined;
    progress?: string | undefined;
    options: Array<{ label: string; description?: string | undefined }>;
    multiSelect: boolean;
  }): Promise<ChoiceSelection> {
    if (this.pendingChoices.has(input.requestId))
      throw new Error("该选择请求已经存在");

    const buttons: MessageButton[][] = [];
    for (let index = 0; index < input.options.length; index += 2) {
      buttons.push(
        input.options.slice(index, index + 2).map((option, offset) => {
          const selectedIndex = index + offset;
          return {
            id: choiceButtonId(input.requestId, String(selectedIndex)),
            label: compactButtonLabel(option.label),
            visitedLabel: compactButtonLabel(`已选·${option.label}`),
            style: 1,
            data: `ccrc:choice:${input.requestId}:${selectedIndex}`,
          };
        }),
      );
    }
    if (input.multiSelect) {
      buttons.push([
        {
          id: choiceButtonId(input.requestId, "done"),
          label: "完成选择",
          visitedLabel: "已提交",
          style: 1,
          data: `ccrc:choice:${input.requestId}:done`,
        },
      ]);
    }
    const detail = input.options
      .map((option, index) => {
        const description = option.description?.trim();
        return `${index + 1}. **${escapeMarkdown(option.label)}**${description ? ` — ${description}` : ""}`;
      })
      .join("\n");
    const heading = [input.progress, input.header]
      .filter(Boolean)
      .map((part) => escapeMarkdown(part as string))
      .join(" · ");
    const multiSelectHelp = input.multiSelect
      ? "\n\n> 可多选：依次点击一个或多个选项，最后点击“完成选择”。"
      : "";
    const text = this.withSessionFooter(
      input.sessionId,
      `## Claude 需要你的选择${heading ? ` · ${heading}` : ""}\n\n${input.question}\n\n${detail}${multiSelectHelp}`,
    );

    let resolveChoice!: (selection: ChoiceSelection) => void;
    let rejectChoice!: (error: Error) => void;
    const result = new Promise<ChoiceSelection>((resolve, reject) => {
      resolveChoice = resolve;
      rejectChoice = reject;
    });
    const pending: PendingChoice = {
      sessionId: input.sessionId,
      requestId: input.requestId,
      options: input.options,
      outputTargetKeys: new Set(this.outputTargets.keys()),
      multiSelect: input.multiSelect,
      selectedIndices: new Set(),
      createdAt: Date.now(),
      resolve: resolveChoice,
      reject: rejectChoice,
    };
    this.pendingChoices.set(input.requestId, pending);
    const delivery = await this.sendToOutputTargets(text, { buttons });
    if (delivery.delivered.size === 0) {
      this.pendingChoices.delete(input.requestId);
      throw new Error("没有可用的 QQ 通知目标；请先从 QQ 向 Bot 发送一条消息");
    }
    pending.outputTargetKeys = delivery.delivered;
    this.logger.info("sent Claude choice request", {
      sessionId: input.sessionId,
      requestId: input.requestId,
      multiSelect: input.multiSelect,
      targets: delivery.delivered.size,
    });
    return result;
  }

  private async handleInbound(
    adapter: PlatformAdapter,
    message: InboundMessage,
  ): Promise<void> {
    const conversationKey = `${adapter.id}:${message.conversationId}`;
    const destinationKey = this.rememberOutputTarget(adapter, message);
    if (message.interactionData) {
      await this.handleButtonInteraction(
        adapter,
        message,
        conversationKey,
        destinationKey,
      );
      return;
    }
    const verdict = PERMISSION_REPLY.exec(message.text);
    if (verdict) {
      const requestId = verdict[2]?.toLowerCase() ?? "";
      const pending = this.pendingPermissions.get(
        permissionKey(destinationKey, requestId),
      );
      if (pending) {
        const behavior = /^(y|yes|allow|允许)$/i.test(verdict[1] ?? "")
          ? ("allow" as const)
          : ("deny" as const);
        const sent = this.registry.send(pending.sessionId, {
          type: "permission_verdict",
          requestId,
          behavior,
        });
        this.deletePermissionRequest(pending.sessionId, requestId);
        if (sent) {
          await adapter.send(
            message.replyTarget,
            behavior === "allow" ? "已允许该操作。" : "已拒绝该操作。",
          );
        } else {
          await adapter.send(
            message.replyTarget,
            "目标 Claude 会话已离线，无法处理该权限请求。",
          );
        }
        return;
      }
    }

    if (message.text.trim().startsWith("/")) {
      const handled = await this.handleCommand(
        adapter,
        message,
        conversationKey,
      );
      if (handled) return;
    }

    const session = this.registry.selected(conversationKey);
    if (!session) {
      const online = this.registry.list();
      if (online.length === 0) {
        await adapter.send(
          message.replyTarget,
          "当前没有在线的 Claude 会话。请先用 ClaudeCodeRemoteControl 启动 Claude。",
        );
      } else {
        await this.sendSessionList(
          adapter,
          message,
          conversationKey,
          "尚未选择会话，请点击序号按钮：",
        );
      }
      return;
    }

    const route = this.rememberRoute(session.metadata.id, adapter, message);
    const attachments = message.attachments
      ? await saveAttachments(
          message.attachments,
          this.paths.attachments,
          this.logger,
        )
      : undefined;

    const sent = this.registry.send(session.metadata.id, {
      type: "inbound",
      routeId: route.id,
      platform: adapter.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      text: message.text,
      ...(attachments ? { attachments } : {}),
    });
    if (!sent)
      await adapter.send(
        message.replyTarget,
        "目标 Claude 会话刚刚离线，请用 /session 重新选择。",
      );
  }

  private async handleButtonInteraction(
    adapter: PlatformAdapter,
    message: InboundMessage,
    conversationKey: string,
    destinationKey: string,
  ): Promise<void> {
    const sessionSelection = /^ccrc:session:(.+)$/.exec(
      message.interactionData ?? "",
    );
    if (sessionSelection) {
      const sessionId = sessionSelection[1] ?? "";
      const session = this.registry.select(conversationKey, sessionId);
      if (!session) {
        await this.sendSessionList(
          adapter,
          message,
          conversationKey,
          "该会话已离线，请重新选择：",
        );
        return;
      }
      this.persistState();
      await adapter.send(
        message.replyTarget,
        `已切换到 **${escapeMarkdown(this.sessionTitle(session.metadata.id))}**\n\n**目录：** \`${escapeMarkdownCode(session.metadata.projectDir)}\``,
      );
      return;
    }

    const permission = /^ccrc:permission:(allow|deny):([a-km-z]{5})$/i.exec(
      message.interactionData ?? "",
    );
    if (permission) {
      const requestId = permission[2]?.toLowerCase() ?? "";
      const pending = this.pendingPermissions.get(
        permissionKey(destinationKey, requestId),
      );
      if (!pending) {
        await adapter.send(message.replyTarget, "该权限请求已结束或过期。");
        return;
      }
      const behavior =
        permission[1]?.toLowerCase() === "allow" ? "allow" : "deny";
      const sent = this.registry.send(pending.sessionId, {
        type: "permission_verdict",
        requestId,
        behavior,
      });
      this.deletePermissionRequest(pending.sessionId, requestId);
      await adapter.send(
        message.replyTarget,
        sent
          ? behavior === "allow"
            ? "已允许该操作。"
            : "已拒绝该操作。"
          : "目标 Claude 会话已离线，无法处理该权限请求。",
      );
      return;
    }

    const choice = /^ccrc:choice:([^:]+):(done|\d+)$/.exec(
      message.interactionData ?? "",
    );
    if (!choice) {
      await adapter.send(message.replyTarget, "无法识别这个按钮操作。");
      return;
    }
    const requestId = choice[1] ?? "";
    const pending = this.pendingChoices.get(requestId);
    if (!pending || !pending.outputTargetKeys.has(destinationKey)) {
      this.logger.warn("QQ choice callback did not match a pending request", {
        requestId,
        destinationKey,
        pending: Boolean(pending),
        targetMatched: Boolean(pending?.outputTargetKeys.has(destinationKey)),
      });
      await adapter.send(message.replyTarget, "该选择已结束或过期。");
      return;
    }

    if (choice[2] === "done") {
      if (!pending.multiSelect) {
        await adapter.send(message.replyTarget, "该选择已结束或过期。");
        return;
      }
      const selection = selectedChoice(pending);
      if (selection.labels.length === 0) {
        await adapter.send(
          message.replyTarget,
          "请先至少选择一项，再点击“完成选择”。",
        );
        return;
      }
      this.pendingChoices.delete(requestId);
      pending.resolve(selection);
      await adapter.send(
        message.replyTarget,
        `已提交：**${selection.labels.map(escapeMarkdown).join("、")}**`,
      );
      return;
    }

    const selectedIndex = Number(choice[2]);
    const option = pending.options[selectedIndex];
    if (!option) {
      await adapter.send(message.replyTarget, "该选择已结束或过期。");
      return;
    }
    if (pending.multiSelect) {
      pending.selectedIndices.add(selectedIndex);
      const labels = selectedChoice(pending).labels;
      await adapter.send(
        message.replyTarget,
        `已选：**${labels.map(escapeMarkdown).join("、")}**\n\n可继续点击其他选项，选完后请点击“完成选择”。`,
      );
      return;
    }

    pending.selectedIndices.add(selectedIndex);
    this.pendingChoices.delete(requestId);
    pending.resolve(selectedChoice(pending));
    await adapter.send(
      message.replyTarget,
      `已选择：**${escapeMarkdown(option.label)}**`,
    );
  }

  private async handleCommand(
    adapter: PlatformAdapter,
    message: InboundMessage,
    conversationKey: string,
  ): Promise<boolean> {
    const [rawCommand = "", ...parts] = message.text.trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    if (command === "/session") {
      await this.sendSessionList(adapter, message, conversationKey);
      return true;
    }
    if (command === "/sessions" || command === "/list" || command === "/会话") {
      await this.sendSessionList(
        adapter,
        message,
        conversationKey,
        "命令已改为 `/session`，请点击序号按钮选择会话。",
      );
      return true;
    }
    if (command === "/use" || command === "/switch" || command === "/切换") {
      await this.sendSessionList(
        adapter,
        message,
        conversationKey,
        "`/use` 已废弃，请使用 `/session` 并点击序号按钮选择会话。",
      );
      return true;
    }
    if (command === "/current" || command === "/当前") {
      const session = this.registry.selected(conversationKey);
      await adapter.send(
        message.replyTarget,
        session
          ? `**当前会话：** ${escapeMarkdown(this.sessionTitle(session.metadata.id))}\n\n**目录：** \`${escapeMarkdownCode(session.metadata.projectDir)}\``
          : "当前没有选中的在线会话。",
      );
      return true;
    }
    if (command === "/rename" || command === "/重命名") {
      const name = parts.join(" ").trim();
      const current = this.registry.selected(conversationKey);
      if (!current || !name) {
        await adapter.send(
          message.replyTarget,
          "用法：/rename <新名称>（需要先选择在线会话）",
        );
        return true;
      }
      if (name.length > 64 || /[\r\n]/.test(name)) {
        await adapter.send(
          message.replyTarget,
          "会话名称必须在 1–64 个字符内且不能换行。",
        );
        return true;
      }
      this.registry.rename(current.metadata.id, name);
      this.sessionDetails.set(current.metadata.id, {
        ...this.sessionDetails.get(current.metadata.id),
        title: name,
        projectDir: current.metadata.projectDir,
      });
      this.persistState();
      await adapter.send(message.replyTarget, `会话已重命名为：${name}`);
      return true;
    }
    if (command === "/help" || command === "/帮助") {
      await adapter.send(
        message.replyTarget,
        [
          "ClaudeCodeRemoteControl 命令：",
          "/session — 列出在线会话，点击序号按钮切换 QQ 输入目标",
          "/current — 当前会话",
          "/rename <名称> — 重命名当前会话",
          "所有 Claude 会话的阶段性文字和最终回复都会推送到这里，会话选择只影响 QQ 输入目标",
          "/help — 显示帮助",
          "",
          "其他消息会直接发送给选中的 Claude 会话。",
        ].join("\n"),
      );
      return true;
    }
    return false;
  }

  private async sendSessionList(
    adapter: PlatformAdapter,
    message: InboundMessage,
    conversationKey: string,
    prefix?: string,
  ): Promise<void> {
    const buttons = this.sessionButtons(conversationKey);
    await adapter.send(
      message.replyTarget,
      [prefix, this.formatSessions(conversationKey)]
        .filter(Boolean)
        .join("\n\n"),
      buttons.length > 0 ? { buttons } : undefined,
    );
  }

  private formatSessions(conversationKey: string): string {
    const sessions = this.registry.list();
    if (sessions.length === 0) return "当前没有在线的 Claude 会话。";
    const current = this.registry.selected(conversationKey)?.metadata.id;
    const lines = sessions.map((session, index) => {
      const marker = session.id === current ? "●" : "○";
      return `${marker} ${index + 1}. **${escapeMarkdown(this.sessionTitle(session.id))}**\n   \`${escapeMarkdownCode(session.projectDir)}\``;
    });
    return `在线 Claude 会话：\n${lines.join("\n")}`;
  }

  private sessionButtons(conversationKey: string): MessageButton[][] {
    const sessions = this.registry.list().slice(0, 25);
    const current = this.registry.selected(conversationKey)?.metadata.id;
    const rows: MessageButton[][] = [];
    for (let offset = 0; offset < sessions.length; offset += 5) {
      rows.push(
        sessions.slice(offset, offset + 5).map((session, index) => {
          const sequence = String(offset + index + 1);
          return {
            id: `session-${sequence}`,
            label: sequence,
            visitedLabel: sequence,
            style: session.id === current ? 1 : 0,
            data: `ccrc:session:${session.id}`,
          };
        }),
      );
    }
    return rows;
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (!this.authorized(request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, {
        ok: true,
        pid: process.pid,
        protocol: PROTOCOL_VERSION,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      json(response, 200, this.status());
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/hooks/assistant-response"
    ) {
      void this.handleAssistantResponseRequest(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/hooks/ask-user-question"
    ) {
      void this.handleAskUserQuestionRequest(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/hooks/ask-user-question/complete"
    ) {
      void this.handleAskUserQuestionCompletion(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      json(response, 202, { ok: true });
      setImmediate(() => void this.stop());
      return;
    }
    json(response, 404, { error: "not found" });
  }

  private authorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.token}`;
  }

  private rememberRoute(
    sessionId: string,
    adapter: PlatformAdapter,
    message: InboundMessage,
  ): RouteRecord {
    const route: RouteRecord = {
      id: randomBytes(12).toString("hex"),
      sessionId,
      platformId: adapter.id,
      target: message.replyTarget,
      createdAt: Date.now(),
    };
    this.routes.set(route.id, route);
    return route;
  }

  private deletePermissionRequest(sessionId: string, requestId: string): void {
    for (const [key, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId && pending.requestId === requestId) {
        this.pendingPermissions.delete(key);
      }
    }
  }

  private rememberOutputTarget(
    adapter: PlatformAdapter,
    message: InboundMessage,
  ): string {
    const target = withoutInboundMessageId(message.replyTarget);
    const key = outputTargetKey(adapter.id, target);
    const next: PersistedOutputTarget = {
      platformId: adapter.id,
      target,
    };
    const previous = this.outputTargets.get(key);
    this.outputTargets.set(key, next);
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.persistState();
    return key;
  }

  private migrateLegacyOutputTargets(state: BrokerState): boolean {
    let changed = false;
    for (const conversationKey of Object.keys(state.selections)) {
      for (const platform of this.config.platforms) {
        if (platform.type !== "qqbot") continue;
        const prefix = `${platform.id}:`;
        if (!conversationKey.startsWith(prefix)) continue;
        const conversationId = conversationKey.slice(prefix.length);
        const target = legacyQQTarget(
          conversationId,
          platform.shareGroupSession,
        );
        if (!target) continue;
        const key = outputTargetKey(platform.id, target);
        if (this.outputTargets.has(key)) continue;
        this.outputTargets.set(key, { platformId: platform.id, target });
        changed = true;
      }
    }
    return changed;
  }

  private async handleAssistantResponseRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const input = assistantResponseSchema.parse(
        await readJsonBody(request, HOOK_BODY_LIMIT),
      );
      const result = await this.mirrorAssistantResponse(input);
      json(response, 200, { ok: true, ...result });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      this.logger.warn("failed to mirror Claude response", {
        error: String(error),
      });
      json(response, status, { ok: false, error: String(error) });
    }
  }

  private async handleAskUserQuestionRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let activeChoiceId: string | undefined;
    let clientClosed = false;
    const cancel = () => {
      if (response.writableEnded) return;
      clientClosed = true;
      if (activeChoiceId) {
        this.logger.info("Claude choice hook disconnected", {
          requestId: activeChoiceId,
        });
        this.cancelChoice(
          activeChoiceId,
          new Error("Claude hook disconnected"),
        );
      }
    };
    request.once("aborted", cancel);
    response.once("close", cancel);

    try {
      const input = askUserQuestionSchema.parse(
        await readJsonBody(request, HOOK_BODY_LIMIT),
      );
      if (!this.registry.get(input.sessionId)) {
        json(response, 409, {
          ok: false,
          error: "Claude session does not have an active CCRC Channel",
        });
        return;
      }
      if (input.projectDir) {
        this.sessionDetails.set(input.sessionId, {
          ...this.sessionDetails.get(input.sessionId),
          projectDir: input.projectDir,
        });
      }

      const answers: Record<string, string> = {};
      for (const [index, question] of input.questions.entries()) {
        if (clientClosed) return;
        activeChoiceId = `hook-${randomBytes(10).toString("hex")}`;
        const selection = await this.waitForChoice({
          sessionId: input.sessionId,
          requestId: activeChoiceId,
          question: question.question,
          ...(question.header ? { header: question.header } : {}),
          ...(input.questions.length > 1
            ? { progress: `问题 ${index + 1}/${input.questions.length}` }
            : {}),
          options: question.options,
          multiSelect: question.multiSelect,
        });
        answers[question.question] = selection.labels.join(", ");
        activeChoiceId = undefined;
      }
      if (!clientClosed) json(response, 200, { ok: true, answers });
    } catch (error) {
      if (activeChoiceId) this.cancelChoice(activeChoiceId, error as Error);
      if (clientClosed) return;
      const completedLocally = (error as Error).message.includes(
        "选择已在 Claude 终端完成",
      );
      const status =
        error instanceof z.ZodError
          ? 400
          : completedLocally
            ? 409
            : (error as Error).message.includes("没有可用的 QQ")
              ? 409
              : 500;
      if (!completedLocally) {
        this.logger.warn("failed to bridge Claude choice request", {
          error: String(error),
        });
      }
      json(response, status, { ok: false, error: String(error) });
    } finally {
      request.off("aborted", cancel);
      response.off("close", cancel);
    }
  }

  private async handleAskUserQuestionCompletion(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const { sessionId, answers } = askUserQuestionCompletionSchema.parse(
        await readJsonBody(request, HOOK_BODY_LIMIT),
      );
      let canceled = 0;
      const notificationTargets = new Set<string>();
      for (const [requestId, pending] of this.pendingChoices) {
        if (pending.sessionId !== sessionId || !requestId.startsWith("hook-"))
          continue;
        for (const key of pending.outputTargetKeys)
          notificationTargets.add(key);
        this.pendingChoices.delete(requestId);
        pending.reject(new Error("选择已在 Claude 终端完成"));
        canceled += 1;
      }
      if (canceled > 0) {
        this.logger.info("canceled QQ choice after local Claude answer", {
          sessionId,
          count: canceled,
        });
        const answerText = answers
          ? `\n\n${Object.entries(answers)
              .map(
                ([question, answer]) =>
                  `- **${escapeMarkdown(question)}：** ${escapeMarkdown(answer)}`,
              )
              .join("\n")}`
          : "";
        void this.sendToOutputTargetKeys(
          notificationTargets,
          this.withSessionFooter(
            sessionId,
            `## 选择已结束\n\n已在 Claude 终端完成，本次 QQ 选择无需再操作。${answerText}`,
          ),
        );
      }
      json(response, 200, { ok: true, canceled });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      json(response, status, { ok: false, error: String(error) });
    }
  }

  private cancelChoice(requestId: string, error: Error): void {
    const pending = this.pendingChoices.get(requestId);
    if (!pending) return;
    this.pendingChoices.delete(requestId);
    pending.reject(error);
  }

  private async mirrorAssistantResponse(input: {
    sessionId: string;
    messageId: string;
    text: string;
    origin: "external" | "local";
    title?: string | undefined;
    projectDir?: string | undefined;
  }): Promise<{
    delivered: boolean;
    reason?: string;
    deliveredTargets?: number;
    failedTargets?: number;
  }> {
    if (!this.registry.get(input.sessionId))
      return { delivered: false, reason: "channel-not-connected" };
    if (input.origin === "local" && !this.config.broker.mirrorLocalReplies)
      return { delivered: false, reason: "local-mirroring-disabled" };

    const dedupeKey = `${input.sessionId}:${input.messageId}`;
    if (this.mirroredMessages.has(dedupeKey))
      return { delivered: false, reason: "duplicate-hook" };
    // PreToolUse and PostToolUse can arrive concurrently for parallel tools in
    // the same assistant message. Reserve the ID before the first async send.
    this.mirroredMessages.set(dedupeKey, Date.now());

    this.sessionDetails.set(input.sessionId, {
      ...this.sessionDetails.get(input.sessionId),
      ...(input.title ? { title: input.title } : {}),
      ...(input.projectDir ? { projectDir: input.projectDir } : {}),
    });

    const explicit = this.explicitReplies.get(input.sessionId);
    const duplicateOutputTarget =
      explicit &&
      Date.now() - explicit.sentAt <= REPLY_DEDUPE_MS &&
      explicit.text.trim() === input.text.trim()
        ? explicit.outputTargetKey
        : undefined;
    const text = this.withSessionFooter(input.sessionId, input.text, {
      title: input.title,
      projectDir: input.projectDir,
    });
    const result = await this.sendToOutputTargets(
      text,
      undefined,
      duplicateOutputTarget,
    );
    if (result.delivered.size === 0) {
      if (duplicateOutputTarget && result.skipped === 1) {
        return { delivered: false, reason: "duplicate-explicit-reply" };
      }
      // Keep failed deliveries retryable by the next lifecycle hook (usually
      // PostToolUse or Stop).
      this.mirroredMessages.delete(dedupeKey);
      return {
        delivered: false,
        reason:
          this.outputTargets.size === 0
            ? "no-output-targets"
            : "all-output-targets-failed",
        ...(result.failed > 0 ? { failedTargets: result.failed } : {}),
      };
    }

    this.logger.info("broadcast Claude response", {
      sessionId: input.sessionId,
      messageId: input.messageId,
      origin: input.origin,
      deliveredTargets: result.delivered.size,
      failedTargets: result.failed,
    });
    return {
      delivered: true,
      deliveredTargets: result.delivered.size,
      failedTargets: result.failed,
    };
  }

  private async sendToOutputTargets(
    text: string,
    options?: SendOptions,
    excludedKey?: string,
  ): Promise<{ delivered: Set<string>; failed: number; skipped: number }> {
    return this.sendToOutputTargetKeys(
      this.outputTargets.keys(),
      text,
      options,
      excludedKey,
    );
  }

  private async sendToOutputTargetKeys(
    targetKeys: Iterable<string>,
    text: string,
    options?: SendOptions,
    excludedKey?: string,
  ): Promise<{ delivered: Set<string>; failed: number; skipped: number }> {
    const delivered = new Set<string>();
    let failed = 0;
    let skipped = 0;
    for (const key of targetKeys) {
      if (key === excludedKey) {
        skipped += 1;
        continue;
      }
      const outputTarget = this.outputTargets.get(key);
      if (!outputTarget) {
        failed += 1;
        continue;
      }
      const platform = this.platforms.get(outputTarget.platformId);
      if (!platform) {
        failed += 1;
        continue;
      }
      try {
        await platform.adapter.send(outputTarget.target, text, options);
        delivered.add(key);
      } catch (error) {
        failed += 1;
        this.logger.warn("failed to send output notification", {
          platform: outputTarget.platformId,
          conversationId: outputTarget.target.conversationId,
          error: String(error),
        });
      }
    }
    return { delivered, failed, skipped };
  }

  private withSessionFooter(
    sessionId: string,
    text: string,
    details: SessionDetails = {},
  ): string {
    const connected = this.registry.get(sessionId);
    const remembered = this.sessionDetails.get(sessionId);
    const projectDir =
      details.projectDir ??
      remembered?.projectDir ??
      connected?.metadata.projectDir;
    const rawTitle =
      details.title ?? remembered?.title ?? connected?.displayName;
    const title = friendlySessionTitle(rawTitle, projectDir, sessionId);
    // Same blockquote the tool-activity hint uses: QQ has no font-size
    // primitive, headings render larger and bolder, and a fenced block would be
    // shown as real code.
    return [
      text.trim(),
      "",
      "---",
      `> 会话：${escapeMarkdownCode(title)}`,
      ...(projectDir ? [`> 目录：${escapeMarkdownCode(projectDir)}`] : []),
    ].join("\n");
  }

  private sessionTitle(sessionId: string): string {
    const connected = this.registry.get(sessionId);
    const details = this.sessionDetails.get(sessionId);
    return friendlySessionTitle(
      details?.title ?? connected?.displayName,
      details?.projectDir ?? connected?.metadata.projectDir,
      sessionId,
    );
  }

  private sendSocket(socket: WebSocket, message: BrokerMessage): void {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  }

  private persistState(): void {
    const snapshot: BrokerState = {
      ...this.registry.exportState(),
      outputTargets: Object.fromEntries(this.outputTargets),
    };
    this.stateWrite = this.stateWrite
      .catch(() => undefined)
      .then(() => saveState(this.paths.state, snapshot))
      .catch((error) =>
        this.logger.warn("failed to persist broker state", {
          error: String(error),
        }),
      );
  }

  private sweep(): void {
    const now = Date.now();
    const staleSessions = this.registry.closeStale(new Date(now - 90_000));
    if (staleSessions > 0) {
      this.logger.warn("closed stale Channel clients", {
        count: staleSessions,
      });
    }
    for (const [id, route] of this.routes) {
      if (now - route.createdAt > ROUTE_TTL_MS) this.routes.delete(id);
    }
    for (const [key, pending] of this.pendingPermissions) {
      if (now - pending.createdAt > PERMISSION_TTL_MS)
        this.pendingPermissions.delete(key);
    }
    for (const [requestId, pending] of this.pendingChoices) {
      if (now - pending.createdAt <= CHOICE_TTL_MS) continue;
      this.pendingChoices.delete(requestId);
      pending.reject(new Error("QQ 选择请求已过期"));
    }
    for (const [key, timestamp] of this.mirroredMessages) {
      if (now - timestamp > ROUTE_TTL_MS) this.mirroredMessages.delete(key);
    }
    for (const [sessionId, reply] of this.explicitReplies) {
      if (now - reply.sentAt > REPLY_DEDUPE_MS)
        this.explicitReplies.delete(sessionId);
    }
  }
}

function selectedChoice(pending: PendingChoice): ChoiceSelection {
  const selectedIndices = [...pending.selectedIndices].sort((a, b) => a - b);
  return {
    selectedIndices,
    labels: selectedIndices.map((index) => pending.options[index]?.label ?? ""),
  };
}

function compactButtonLabel(value: string): string {
  const points = [...value.trim()];
  return points.length <= 12
    ? value.trim()
    : `${points.slice(0, 11).join("")}…`;
}

function choiceButtonId(requestId: string, suffix: string): string {
  return `choice-${requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-20)}-${suffix}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function permissionKey(outputTargetKey: string, requestId: string): string {
  return `${outputTargetKey}:${requestId}`;
}

function withoutInboundMessageId(target: ReplyTarget): ReplyTarget {
  const { messageId: _messageId, ...proactiveTarget } = target;
  return proactiveTarget;
}

function outputTargetKey(platformId: string, target: ReplyTarget): string {
  const messageType = target.context.messageType;
  if (messageType === "group" && target.context.groupOpenId)
    return `${platformId}:group:${target.context.groupOpenId}`;
  if (messageType === "c2c" && target.context.userOpenId)
    return `${platformId}:c2c:${target.context.userOpenId}`;
  return `${platformId}:${target.conversationId}`;
}

function legacyQQTarget(
  conversationId: string,
  shareGroupSession: boolean,
): ReplyTarget | undefined {
  if (conversationId.startsWith("c2c:")) {
    const userOpenId = conversationId.slice("c2c:".length);
    if (!userOpenId) return undefined;
    return {
      conversationId,
      senderId: userOpenId,
      context: { messageType: "c2c", userOpenId },
    };
  }
  if (conversationId.startsWith("group:")) {
    const parts = conversationId.slice("group:".length).split(":");
    const groupOpenId = parts[0];
    if (!groupOpenId) return undefined;
    const senderId = shareGroupSession
      ? groupOpenId
      : (parts[1] ?? groupOpenId);
    return {
      conversationId,
      senderId,
      context: { messageType: "group", groupOpenId, userOpenId: senderId },
    };
  }
  return undefined;
}

function friendlySessionTitle(
  rawTitle: string | undefined,
  projectDir: string | undefined,
  sessionId: string,
): string {
  const suffix = `-${shortId(sessionId)}`;
  const cleaned = rawTitle?.trim();
  if (cleaned) {
    const withoutGeneratedId = cleaned.endsWith(suffix)
      ? cleaned.slice(0, -suffix.length)
      : cleaned;
    if (withoutGeneratedId) return withoutGeneratedId;
  }
  return projectDir ? basename(projectDir) || "Claude 会话" : "Claude 会话";
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+.!>|])/g, "\\$1");
}

function escapeMarkdownCode(value: string): string {
  return value.replaceAll("`", "'");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJsonBody(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function defaultSessionName(
  projectDir: string,
  sessionId: string,
): string {
  return `${basename(projectDir) || "Claude"}-${shortId(sessionId)}`;
}
