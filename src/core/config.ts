import { readFile } from "node:fs/promises";
import { z } from "zod";
import { type ClaudeCodeRemoteControlPaths } from "./paths.js";

const qqBotSchema = z.object({
  type: z.literal("qqbot"),
  id: z.string().min(1).default("qqbot"),
  enabled: z.boolean().default(true),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  sandbox: z.boolean().default(false),
  intents: z
    .number()
    .int()
    .positive()
    .default((1 << 25) | (1 << 26)),
  allowedSenders: z.array(z.string().min(1)).min(1),
  allowedConversations: z.array(z.string().min(1)).default([]),
  shareGroupSession: z.boolean().default(false),
  markdown: z.boolean().default(true),
});

export type QQBotConfig = z.infer<typeof qqBotSchema>;
export type PlatformConfig = QQBotConfig;

const configSchema = z
  .object({
    broker: z
      .object({
        host: z.literal("127.0.0.1").default("127.0.0.1"),
        port: z.number().int().min(1024).max(65535).default(43921),
        autoStart: z.boolean().default(true),
        mirrorLocalReplies: z.boolean().default(true),
        tag: z.string().trim().max(16).optional(),
      })
      .default({}),
    platforms: z.array(z.discriminatedUnion("type", [qqBotSchema])).default([]),
  })
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, platform] of config.platforms.entries()) {
      if (ids.has(platform.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["platforms", index, "id"],
          message: `duplicate platform id: ${platform.id}`,
        });
      }
      ids.add(platform.id);
    }
  });

export type ClaudeCodeRemoteControlConfig = z.infer<typeof configSchema>;

function cleanEnvironmentValue(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned || cleaned.startsWith("${user_config.")) return undefined;
  return cleaned;
}

function splitList(value: string | undefined): string[] | undefined {
  const cleaned = cleanEnvironmentValue(value);
  if (!cleaned) return undefined;
  return cleaned
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeEnvironment(
  fileConfig: unknown,
  env: NodeJS.ProcessEnv,
): unknown {
  const base =
    fileConfig && typeof fileConfig === "object"
      ? structuredClone(fileConfig as Record<string, unknown>)
      : {};
  const record = base as Record<string, unknown>;
  const broker =
    record.broker && typeof record.broker === "object"
      ? (record.broker as Record<string, unknown>)
      : {};
  const port = cleanEnvironmentValue(env.CCRC_BROKER_PORT);
  if (port) broker.port = Number(port);
  const tag = cleanEnvironmentValue(env.CCRC_BROKER_TAG);
  if (tag) broker.tag = tag;
  record.broker = broker;

  const appId = cleanEnvironmentValue(env.CCRC_QQ_APP_ID);
  const appSecret = cleanEnvironmentValue(env.CCRC_QQ_APP_SECRET);
  const allowedSenders = splitList(env.CCRC_QQ_ALLOWED_SENDERS);
  const hasQQEnvironment = Boolean(appId || appSecret || allowedSenders);
  if (!hasQQEnvironment) return record;

  const platforms = Array.isArray(record.platforms)
    ? [...record.platforms]
    : [];
  const index = platforms.findIndex(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "qqbot",
  );
  const existing =
    index >= 0
      ? (platforms[index] as Record<string, unknown>)
      : { type: "qqbot" };
  const qq = {
    ...existing,
    ...(appId ? { appId } : {}),
    ...(appSecret ? { appSecret } : {}),
    ...(allowedSenders ? { allowedSenders } : {}),
    ...(env.CCRC_QQ_SANDBOX ? { sandbox: env.CCRC_QQ_SANDBOX === "true" } : {}),
  };
  if (!qq.appId || !qq.appSecret) {
    throw new Error(
      "CCRC_QQ_APP_ID and CCRC_QQ_APP_SECRET must be set together or supplied by the config file",
    );
  }
  if (!Array.isArray(qq.allowedSenders) || qq.allowedSenders.length === 0) {
    throw new Error(
      "CCRC_QQ_ALLOWED_SENDERS is required; use * only if you intentionally allow everyone",
    );
  }
  if (index >= 0) platforms[index] = qq;
  else platforms.push(qq);
  record.platforms = platforms;
  return record;
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, removeUndefined(item)]),
  );
}

export async function loadConfig(
  paths: ClaudeCodeRemoteControlPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCodeRemoteControlConfig> {
  let fileConfig: unknown;
  try {
    fileConfig = JSON.parse(await readFile(paths.config, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `failed to read ${paths.config}: ${(error as Error).message}`,
      );
    }
  }

  const input = mergeEnvironment(fileConfig, env);
  return configSchema.parse(removeUndefined(input));
}

export function safeConfigSummary(
  config: ClaudeCodeRemoteControlConfig,
): Record<string, unknown> {
  return {
    broker: config.broker,
    platforms: config.platforms.map((platform) => ({
      id: platform.id,
      type: platform.type,
      enabled: platform.enabled,
      sandbox: platform.sandbox,
      allowedSenders: platform.allowedSenders.length,
    })),
  };
}
