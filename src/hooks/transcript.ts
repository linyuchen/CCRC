import { open, stat } from "node:fs/promises";

const MAX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

/** Placeholder turns Claude Code writes itself (interrupted tool calls, API errors). */
const SYNTHETIC_MODEL = "<synthetic>";

/** Tool detail lines mirrored per assistant message before truncation. */
const MAX_TOOL_DETAIL_LINES = 10;

/** Longest single detail line before it is clipped. */
const MAX_TOOL_DETAIL_CHARS = 200;

export interface AssistantResponse {
  messageId: string;
  text: string;
  origin: "external" | "local";
  title?: string;
  projectDir?: string;
}

interface TranscriptRecord {
  type?: string;
  uuid?: string;
  sessionId?: string;
  session_id?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  customTitle?: string;
  cwd?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
  };
}

interface TranscriptContentBlock {
  type?: string;
  text?: string;
  input?: unknown;
  name?: string;
}

export async function readLastAssistantResponse(
  transcriptPath: string,
  sessionId: string,
): Promise<AssistantResponse | undefined> {
  const fileStat = await stat(transcriptPath);
  const start = Math.max(0, fileStat.size - MAX_TRANSCRIPT_TAIL_BYTES);
  const length = fileStat.size - start;
  const handle = await open(transcriptPath, "r");
  let content: string;
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    content = buffer.toString("utf8");
  } finally {
    await handle.close();
  }

  const lines = content.split("\n");
  if (start > 0) lines.shift();
  const title = findSessionTitle(lines, sessionId);

  // Claude Code splits one assistant message across consecutive records, one
  // per content block, tied together by message.id. Merge the newest message's
  // blocks so text is not lost behind the trailing tool_use record.
  let newest: { record: TranscriptRecord; index: number } | undefined;
  const blocks: unknown[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (
      record.type !== "assistant" ||
      record.message?.role !== "assistant" ||
      record.isSidechain ||
      record.isApiErrorMessage ||
      record.message?.model === SYNTHETIC_MODEL
    )
      continue;
    const recordSessionId = record.sessionId ?? record.session_id;
    if (recordSessionId && recordSessionId !== sessionId) continue;
    if (newest && !sameAssistantMessage(newest.record, record)) break;
    blocks.unshift(...contentBlocks(record.message.content));
    newest ??= { record, index };
    // A record without message.id carries the whole message on its own.
    if (!record.message.id) break;
  }
  if (!newest) return undefined;

  const text = assistantText(blocks);
  if (!text) return undefined;
  const messageId = newest.record.message?.id ?? newest.record.uuid;
  if (!messageId) return undefined;
  return {
    messageId,
    text,
    origin: findTurnOrigin(lines, newest.index - 1, sessionId),
    ...(title ? { title } : {}),
    ...(newest.record.cwd ? { projectDir: newest.record.cwd } : {}),
  };
}

function sameAssistantMessage(
  newest: TranscriptRecord,
  older: TranscriptRecord,
): boolean {
  const id = newest.message?.id;
  return Boolean(id) && id === older.message?.id;
}

function contentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function findSessionTitle(
  lines: string[],
  sessionId: string,
): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    const recordSessionId = record.sessionId ?? record.session_id;
    if (recordSessionId && recordSessionId !== sessionId) continue;
    const title = record.customTitle?.trim();
    if (record.type === "custom-title" && title) return title;
  }
  return undefined;
}

function findTurnOrigin(
  lines: string[],
  startIndex: number,
  sessionId: string,
): "external" | "local" {
  for (let index = startIndex; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (record.type !== "user" || record.message?.role !== "user") continue;
    const recordSessionId = record.sessionId ?? record.session_id;
    if (recordSessionId && recordSessionId !== sessionId) continue;
    const text = userText(record.message.content);
    if (!text) continue;
    return isExternalChannelMessage(text) ? "external" : "local";
  }
  return "local";
}

function isExternalChannelMessage(text: string): boolean {
  return (
    /<ccrc_context\s+[^>]*\broute_id=["'][^"']+["'][^>]*\/>/i.test(text) ||
    /<channel\s+[^>]*source=["'](?:ccrc|plugin:ccrc:ccrc)["']/i.test(text)
  );
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const blocks = content.filter(
    (block): block is TranscriptContentBlock =>
      Boolean(block) && typeof block === "object",
  );
  const text = blocks
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  const toolUses = blocks.filter(
    (block): block is TranscriptContentBlock & { type: "tool_use" } =>
      block.type === "tool_use",
  );
  if (toolUses.length === 0) return text;

  const activity = toolActivity(
    toolUses.map((block) => block.name?.trim() ?? ""),
  );
  const quoted = [activity, ...toolDetails(toolUses)]
    .map((line) => `> ${line}`)
    .join("\n");
  return text ? `${text}\n\n${quoted}` : quoted;
}

/** Input fields worth showing, most specific first. */
const TOOL_DETAIL_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "pattern",
  "url",
  "query",
  "description",
  "question",
  "plan",
  "prompt",
  "text",
  "path",
  "skill",
];

function toolDetails(blocks: TranscriptContentBlock[]): string[] {
  // The hint already names a lone tool; only a parallel batch needs labels.
  const labeled = blocks.length > 1;
  const lines = blocks.flatMap((block) => toolDetailLines(block, labeled));
  if (lines.length <= MAX_TOOL_DETAIL_LINES) return lines;
  return [...lines.slice(0, MAX_TOOL_DETAIL_LINES), "…"];
}

function toolDetailLines(
  block: TranscriptContentBlock,
  labeled: boolean,
): string[] {
  const name = block.name?.trim() || "工具";
  const detail = toolDetailText(block.input);
  if (!detail) return labeled ? [name] : [];
  return (labeled ? `${name}: ${detail}` : detail)
    .split("\n")
    .map(clampDetailLine);
}

function toolDetailText(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of TOOL_DETAIL_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // Unknown or MCP tool: any string field beats showing nothing at all.
  for (const value of Object.values(fields))
    if (typeof value === "string" && value.trim()) return value.trim();
  const json = JSON.stringify(fields);
  return !json || json === "{}" ? "" : json;
}

/** `mcp__plugin_ccrc_ccrc__reply` reads better as just `reply`. */
function shortToolName(toolName: string): string {
  const parts = toolName.split("__").filter(Boolean);
  return parts[parts.length - 1] ?? toolName;
}

function clampDetailLine(line: string): string {
  return line.length > MAX_TOOL_DETAIL_CHARS
    ? `${line.slice(0, MAX_TOOL_DETAIL_CHARS)}…`
    : line;
}

function toolActivity(toolNames: string[]): string {
  if (toolNames.length > 1) return `正在并行执行 ${toolNames.length} 项操作…`;
  const toolName = toolNames[0] ?? "";
  if (toolName === "AskUserQuestion") return "正在等待你的选择…";
  if (toolName === "Bash") return "正在执行命令…";
  if (toolName === "Read") return "正在读取文件…";
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "NotebookEdit"
  )
    return "正在修改文件…";
  if (toolName === "Glob" || toolName === "Grep") return "正在搜索文件…";
  if (toolName === "WebFetch" || toolName === "WebSearch")
    return "正在查询资料…";
  if (toolName === "Task" || toolName === "Agent") return "正在处理子任务…";
  return toolName ? `正在调用 ${shortToolName(toolName)}…` : "正在调用工具…";
}

function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}
