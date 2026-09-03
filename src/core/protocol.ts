import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const sessionMetadataSchema = z.object({
  id: z.string().min(1),
  projectDir: z.string().min(1),
  displayName: z.string().min(1),
  startedAt: z.string().datetime(),
  pid: z.number().int().positive(),
});

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(PROTOCOL_VERSION),
    session: sessionMetadataSchema,
  }),
  z.object({ type: z.literal("heartbeat") }),
  z.object({
    type: z.literal("reply"),
    correlationId: z.string().min(1),
    routeId: z.string().min(1),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("permission_request"),
    requestId: z.string().min(1),
    toolName: z.string(),
    description: z.string(),
    inputPreview: z.string(),
  }),
  z.object({
    type: z.literal("choice_request"),
    requestId: z.string().min(1),
    question: z.string().min(1),
    options: z
      .array(
        z.object({
          label: z.string().min(1),
          description: z.string().optional(),
        }),
      )
      .min(2)
      .max(10),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const brokerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello_ack"),
    protocol: z.literal(PROTOCOL_VERSION),
    sessionId: z.string(),
    displayName: z.string(),
  }),
  z.object({
    type: z.literal("inbound"),
    routeId: z.string(),
    platform: z.string(),
    conversationId: z.string(),
    senderId: z.string(),
    senderName: z.string().optional(),
    text: z.string(),
    attachments: z
      .array(
        z.object({
          name: z.string().optional(),
          url: z.string(),
          contentType: z.string().optional(),
          path: z.string().optional(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal("permission_verdict"),
    requestId: z.string(),
    behavior: z.enum(["allow", "deny"]),
  }),
  z.object({
    type: z.literal("choice_result"),
    requestId: z.string(),
    ok: z.boolean(),
    selectedIndex: z.number().int().nonnegative().optional(),
    label: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("ack"),
    correlationId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

export type BrokerMessage = z.infer<typeof brokerMessageSchema>;

export function parseWireMessage(data: unknown): unknown {
  if (typeof data === "string") return JSON.parse(data);
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString("utf8"));
  if (Array.isArray(data))
    return JSON.parse(Buffer.concat(data).toString("utf8"));
  if (data instanceof ArrayBuffer)
    return JSON.parse(Buffer.from(data).toString("utf8"));
  throw new Error("unsupported websocket payload");
}
