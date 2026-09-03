import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket, { type RawData } from "ws";
import type { ClaudeCodeRemoteControlConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type { ClaudeCodeRemoteControlPaths } from "../core/paths.js";
import {
  brokerMessageSchema,
  parseWireMessage,
  PROTOCOL_VERSION,
  type BrokerMessage,
  type ClientMessage,
  type SessionMetadata,
} from "../core/protocol.js";

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingChoice {
  resolve: (answer: { selectedIndex: number; label: string }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export type BrokerEventHandler = (message: BrokerMessage) => Promise<void>;

export class BrokerClient {
  private socket: WebSocket | undefined;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private connectionAttempt: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingChoices = new Map<string, PendingChoice>();
  private connected = false;

  constructor(
    private readonly config: ClaudeCodeRemoteControlConfig,
    private readonly paths: ClaudeCodeRemoteControlPaths,
    private readonly token: string,
    private readonly session: SessionMetadata,
    private readonly logger: Logger,
    private readonly handler: BrokerEventHandler,
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      await ensureBroker(this.config, this.paths, this.token, this.logger);
      await this.connect();
    } catch (error) {
      this.logger.error(
        "initial broker connection failed; retrying in background",
        { error: String(error) },
      );
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reconnectTimer = undefined;
    this.heartbeat = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING)
      socket.close(1000, "channel stopping");
    this.rejectPending(new Error("broker client stopped"));
  }

  async reply(
    routeId: string,
    text: string,
    attachments?: string[],
  ): Promise<void> {
    const correlationId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return this.sendWithAck({
      type: "reply",
      correlationId,
      routeId,
      text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  }

  sendPermissionRequest(request: {
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }): void {
    this.send({ type: "permission_request", ...request });
  }

  async requestChoice(request: {
    requestId: string;
    question: string;
    options: Array<{ label: string; description?: string | undefined }>;
  }): Promise<{ selectedIndex: number; label: string }> {
    if (this.pendingChoices.has(request.requestId))
      throw new Error(`choice request ${request.requestId} is already pending`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingChoices.delete(request.requestId);
        reject(new Error("timed out waiting for a QQ choice"));
      }, 30 * 60_000);
      this.pendingChoices.set(request.requestId, { resolve, reject, timer });
      try {
        this.send({ type: "choice_request", ...request });
      } catch (error) {
        clearTimeout(timer);
        this.pendingChoices.delete(request.requestId);
        reject(error as Error);
      }
    });
  }

  private async connect(): Promise<void> {
    if (this.connectionAttempt) return this.connectionAttempt;
    this.connectionAttempt = this.openSocket().finally(() => {
      this.connectionAttempt = undefined;
    });
    return this.connectionAttempt;
  }

  private async openSocket(): Promise<void> {
    const url = `ws://${this.config.broker.host}:${this.config.broker.port}/channel`;
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let acknowledged = false;
      const timeout = setTimeout(() => {
        reject(new Error("timed out waiting for broker handshake"));
        socket.close();
      }, 8_000);

      socket.once("open", () => {
        const hello: ClientMessage = {
          type: "hello",
          protocol: PROTOCOL_VERSION,
          session: this.session,
        };
        socket.send(JSON.stringify(hello));
      });
      socket.on("message", (raw) => {
        void this.onMessage(raw)
          .then((message) => {
            if (message?.type === "hello_ack" && !acknowledged) {
              acknowledged = true;
              this.connected = true;
              clearTimeout(timeout);
              this.startHeartbeat();
              this.logger.info("connected to broker", {
                sessionId: message.sessionId,
                displayName: message.displayName,
              });
              resolve();
            }
          })
          .catch((error) =>
            this.logger.warn("ignored invalid broker message", {
              error: String(error),
            }),
          );
      });
      socket.once("error", (error) => {
        if (!acknowledged) {
          clearTimeout(timeout);
          reject(error);
        } else {
          this.logger.warn("broker websocket error", { error: error.message });
        }
      });
      socket.once("close", () => {
        clearTimeout(timeout);
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.connected = false;
        if (this.socket === socket) this.socket = undefined;
        this.rejectPending(new Error("broker disconnected"));
        if (!acknowledged) reject(new Error("broker closed before handshake"));
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private async onMessage(raw: RawData): Promise<BrokerMessage | undefined> {
    const message = brokerMessageSchema.parse(parseWireMessage(raw));
    if (message.type === "ack") {
      const pending = this.pending.get(message.correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.correlationId);
        if (message.ok) pending.resolve();
        else
          pending.reject(new Error(message.error ?? "broker rejected request"));
      }
      return message;
    }
    if (message.type === "choice_result") {
      const pending = this.pendingChoices.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingChoices.delete(message.requestId);
        if (
          message.ok &&
          message.selectedIndex !== undefined &&
          message.label !== undefined
        ) {
          pending.resolve({
            selectedIndex: message.selectedIndex,
            label: message.label,
          });
        } else {
          pending.reject(
            new Error(message.error ?? "choice request was not delivered"),
          );
        }
      }
      return message;
    }
    if (message.type === "error") {
      this.logger.warn("broker reported an error", {
        message: message.message,
      });
      return message;
    }
    await this.handler(message);
    return message;
  }

  private send(message: ClientMessage): void {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.connected
    ) {
      throw new Error("ClaudeCodeRemoteControl broker is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  private async sendWithAck(
    message: Extract<ClientMessage, { type: "reply" }>,
  ): Promise<void> {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.connected
    ) {
      throw new Error("ClaudeCodeRemoteControl broker is not connected");
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.correlationId);
        reject(new Error("timed out waiting for broker reply acknowledgement"));
      }, 20_000);
      this.pending.set(message.correlationId, { resolve, reject, timer });
      try {
        this.socket?.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.correlationId);
        reject(error as Error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void ensureBroker(this.config, this.paths, this.token, this.logger)
        .then(() => this.connect())
        .catch((error) => {
          this.logger.warn("broker reconnect failed", { error: String(error) });
          this.scheduleReconnect();
        });
    }, 2_000);
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      try {
        this.send({ type: "heartbeat" });
      } catch {
        // The close handler owns reconnection.
      }
    }, 20_000);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingChoices.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingChoices.clear();
  }
}

export async function brokerHealth(
  config: ClaudeCodeRemoteControlConfig,
  token: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(
      `http://${config.broker.host}:${config.broker.port}/health`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(800),
      },
    );
    if (!response.ok) return undefined;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function ensureBroker(
  config: ClaudeCodeRemoteControlConfig,
  paths: ClaudeCodeRemoteControlPaths,
  token: string,
  logger: Logger,
): Promise<void> {
  if (await brokerHealth(config, token)) return;
  if (!config.broker.autoStart)
    throw new Error("broker is offline and autoStart is disabled");

  const brokerEntry = resolveBrokerEntry();
  const logFd = openSync(paths.log, "a", 0o600);
  const child = (() => {
    try {
      return spawn(process.execPath, [brokerEntry, "serve"], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
    } finally {
      closeSync(logFd);
    }
  })();
  child.unref();
  logger.info("started broker process", { pid: child.pid, log: paths.log });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await brokerHealth(config, token)) return;
  }
  throw new Error(`broker did not become ready; inspect ${paths.log}`);
}

function resolveBrokerEntry(): string {
  if (process.env.CCRC_BROKER_ENTRY) return process.env.CCRC_BROKER_ENTRY;
  const currentDir = dirname(process.argv[1] ?? process.cwd());
  // Bundled channel.cjs and broker.cjs are siblings in dist/.
  return join(currentDir, "broker.cjs");
}
