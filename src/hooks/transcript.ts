import { open, stat } from "node:fs/promises";

const MAX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

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
  customTitle?: string;
  cwd?: string;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
  };
}

interface TranscriptContentBlock {
  type?: string;
  text?: string;
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
      record.isSidechain
    )
      continue;
    const recordSessionId = record.sessionId ?? record.session_id;
    if (recordSessionId && recordSessionId !== sessionId) continue;
    const text = assistantText(record.message.content);
    if (!text) return undefined;
    const messageId = record.uuid ?? record.message.id;
    if (!messageId) continue;
    return {
      messageId,
      text,
      origin: findTurnOrigin(lines, index - 1, sessionId),
      ...(title ? { title } : {}),
      ...(record.cwd ? { projectDir: record.cwd } : {}),
    };
  }
  return undefined;
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
  const toolNames = blocks
    .filter(
      (block): block is TranscriptContentBlock & { type: "tool_use" } =>
        block.type === "tool_use",
    )
    .map((block) => block.name?.trim() ?? "");
  if (!text || toolNames.length === 0) return text;

  const activity = toolActivity(toolNames);
  return text ? `${text}\n\n> ${activity}` : `> ${activity}`;
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
  return "正在调用工具…";
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
