import WebSocket from "ws";
import type { BrokerMessage, SessionMetadata } from "../core/protocol.js";

export interface ConnectedSession {
  metadata: SessionMetadata;
  displayName: string;
  socket: WebSocket;
  connectedAt: Date;
  lastSeenAt: Date;
}

export interface RegistryState {
  selections: Record<string, string>;
  aliases: Record<string, string>;
}

export interface SessionSummary {
  id: string;
  displayName: string;
  projectDir: string;
  connectedAt: Date;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, ConnectedSession>();
  private readonly socketToSession = new Map<WebSocket, string>();
  private readonly selections = new Map<string, string>();
  private readonly aliases = new Map<string, string>();

  constructor(initial?: Partial<RegistryState>) {
    for (const [key, value] of Object.entries(initial?.selections ?? {}))
      this.selections.set(key, value);
    for (const [key, value] of Object.entries(initial?.aliases ?? {}))
      this.aliases.set(key, value);
  }

  register(socket: WebSocket, metadata: SessionMetadata): ConnectedSession {
    const previous = this.sessions.get(metadata.id);
    if (previous && previous.socket !== socket)
      previous.socket.close(4001, "session reconnected");

    const session: ConnectedSession = {
      metadata,
      displayName: this.aliases.get(metadata.id) ?? metadata.displayName,
      socket,
      connectedAt: new Date(),
      lastSeenAt: new Date(),
    };
    this.sessions.set(metadata.id, session);
    this.socketToSession.set(socket, metadata.id);
    return session;
  }

  unregister(socket: WebSocket): ConnectedSession | undefined {
    const id = this.socketToSession.get(socket);
    if (!id) return undefined;
    this.socketToSession.delete(socket);
    const session = this.sessions.get(id);
    if (session?.socket === socket) this.sessions.delete(id);
    return session;
  }

  forSocket(socket: WebSocket): ConnectedSession | undefined {
    const id = this.socketToSession.get(socket);
    return id ? this.sessions.get(id) : undefined;
  }

  get(id: string): ConnectedSession | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime())
      .map((session) => ({
        id: session.metadata.id,
        displayName: session.displayName,
        projectDir: session.metadata.projectDir,
        connectedAt: session.connectedAt,
      }));
  }

  resolve(query: string): ConnectedSession | undefined {
    const trimmed = query.trim();
    if (/^\d+$/.test(trimmed))
      return this.sessions.get(this.list()[Number(trimmed) - 1]?.id ?? "");
    const exact = this.sessions.get(trimmed);
    if (exact) return exact;
    const byName = [...this.sessions.values()].filter(
      (session) => session.displayName === trimmed,
    );
    if (byName.length === 1) return byName[0];
    const byPrefix = [...this.sessions.values()].filter((session) =>
      session.metadata.id.startsWith(trimmed),
    );
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  }

  selected(conversationKey: string): ConnectedSession | undefined {
    const selectedId = this.selections.get(conversationKey);
    if (selectedId) {
      const selected = this.sessions.get(selectedId);
      if (selected) return selected;
    }
    if (this.sessions.size === 1) {
      const only = this.sessions.values().next().value as
        ConnectedSession | undefined;
      if (only) this.selections.set(conversationKey, only.metadata.id);
      return only;
    }
    return undefined;
  }

  select(conversationKey: string, query: string): ConnectedSession | undefined {
    const session = this.resolve(query);
    if (session) this.selections.set(conversationKey, session.metadata.id);
    return session;
  }

  rename(sessionId: string, displayName: string): ConnectedSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.displayName = displayName;
    this.aliases.set(sessionId, displayName);
    return session;
  }

  touch(socket: WebSocket): void {
    const session = this.forSocket(socket);
    if (session) session.lastSeenAt = new Date();
  }

  closeStale(before: Date): number {
    let closed = 0;
    for (const session of this.sessions.values()) {
      if (session.lastSeenAt < before) {
        session.socket.terminate();
        closed += 1;
      }
    }
    return closed;
  }

  send(sessionId: string, message: BrokerMessage): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.socket.readyState !== WebSocket.OPEN) return false;
    session.socket.send(JSON.stringify(message));
    return true;
  }

  exportState(): RegistryState {
    return {
      selections: Object.fromEntries(this.selections),
      aliases: Object.fromEntries(this.aliases),
    };
  }
}
