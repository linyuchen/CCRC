import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import type { ReplyTarget } from "../platforms/types.js";
import type { RegistryState } from "./session-registry.js";

export interface PersistedOutputTarget {
  platformId: string;
  target: ReplyTarget;
}

export interface BrokerState extends RegistryState {
  outputTargets: Record<string, PersistedOutputTarget>;
}

const EMPTY_STATE: BrokerState = {
  selections: {},
  aliases: {},
  outputTargets: {},
};

export async function loadState(path: string): Promise<BrokerState> {
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<BrokerState>;
    return {
      selections: isStringRecord(parsed.selections) ? parsed.selections : {},
      aliases: isStringRecord(parsed.aliases) ? parsed.aliases : {},
      outputTargets: parseOutputTargets(parsed.outputTargets),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    return EMPTY_STATE;
  }
}

export async function saveState(
  path: string,
  state: BrokerState,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, path);
}

function parseOutputTargets(
  value: unknown,
): Record<string, PersistedOutputTarget> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, PersistedOutputTarget] =>
        isPersistedOutputTarget(entry[1]),
    ),
  );
}

function isPersistedOutputTarget(
  value: unknown,
): value is PersistedOutputTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const target = record.target;
  if (!target || typeof target !== "object" || Array.isArray(target))
    return false;
  const replyTarget = target as Record<string, unknown>;
  return (
    typeof record.platformId === "string" &&
    record.platformId.length > 0 &&
    typeof replyTarget.conversationId === "string" &&
    replyTarget.conversationId.length > 0 &&
    typeof replyTarget.senderId === "string" &&
    replyTarget.senderId.length > 0 &&
    (replyTarget.messageId === undefined ||
      typeof replyTarget.messageId === "string") &&
    isStringRecord(replyTarget.context)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every(
      (item) => typeof item === "string",
    )
  );
}
