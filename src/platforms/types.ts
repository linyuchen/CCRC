export interface Attachment {
  name?: string;
  url: string;
  contentType?: string;
  /** Local copy the broker downloaded so a session can open the file. */
  path?: string;
}

export interface ReplyTarget {
  conversationId: string;
  senderId: string;
  messageId?: string;
  context: Record<string, string>;
}

export interface MessageButton {
  id: string;
  label: string;
  data: string;
  visitedLabel?: string;
  style?: 0 | 1;
}

export interface SendOptions {
  buttons?: MessageButton[][];
}

export interface InboundMessage {
  platform: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  text: string;
  attachments?: Attachment[];
  interactionData?: string;
  receivedAt: Date;
  replyTarget: ReplyTarget;
}

export type InboundHandler = (message: InboundMessage) => Promise<void>;

export interface PlatformAdapter {
  readonly id: string;
  readonly type: string;
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  send(target: ReplyTarget, text: string, options?: SendOptions): Promise<void>;
}
