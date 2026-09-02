import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeRemoteControlConfig } from "../src/core/config.js";
import { mirrorStopHook } from "../src/hooks/stop-handler.js";
import { readLastAssistantResponse } from "../src/hooks/transcript.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Stop hook", () => {
  it("extracts the final assistant text without thinking or tool blocks", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "question" } },
      {
        type: "custom-title",
        sessionId: "session-a",
        customTitle: "修复远程控制",
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        sessionId: "session-a",
        cwd: "/work/remote-control",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toEqual({
      messageId: "assistant-1",
      text: "first\nsecond",
      origin: "local",
      title: "修复远程控制",
      projectDir: "/work/remote-control",
    });
  });

  it("adds an activity hint followed by the tool detail", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "检查一下" } },
      {
        type: "assistant",
        uuid: "assistant-tool",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "我来检查：" },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "secret-command --token hidden" },
            },
          ],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toMatchObject({
      text: "我来检查：\n\n> 正在执行命令…\n> secret-command --token hidden",
    });
  });

  it("truncates tool detail beyond ten lines with an ellipsis", async () => {
    const command = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "跑一下" } },
      {
        type: "assistant",
        uuid: "assistant-long-command",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command } }],
        },
      },
    ]);

    const response = await readLastAssistantResponse(transcript, "session-a");
    expect(response?.text).toBe(
      [
        "> 正在执行命令…",
        "> line 1",
        ...Array.from({ length: 9 }, (_, i) => `> line ${i + 2}`),
        "> …",
      ].join("\n"),
    );
    // 10 detail lines + the hint, never the remaining 5.
    expect(response?.text).not.toContain("line 11");
  });

  it("names an unrecognized tool and still shows its detail", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "回一下" } },
      {
        type: "assistant",
        uuid: "assistant-mcp",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "mcp__plugin_ccrc_ccrc__reply",
              input: { route_id: "ec68a8b6", text: "已收到" },
            },
          ],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toMatchObject({ text: "> 正在调用 reply…\n> 已收到" });
  });

  it("falls back to compact JSON for tool input with no string field", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "记一下" } },
      {
        type: "assistant",
        uuid: "assistant-todo",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "TodoWrite",
              input: { todos: [{ content: "写测试", status: "pending" }] },
            },
          ],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toMatchObject({
      text: '> 正在调用 TodoWrite…\n> {"todos":[{"content":"写测试","status":"pending"}]}',
    });
  });

  it("clips a detail line longer than the character cap", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "跑一下" } },
      {
        type: "assistant",
        uuid: "assistant-long-line",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "x".repeat(500) },
            },
          ],
        },
      },
    ]);

    const response = await readLastAssistantResponse(transcript, "session-a");
    expect(response?.text).toBe(`> 正在执行命令…\n> ${"x".repeat(200)}…`);
  });

  it("mirrors a tool-only assistant message as an activity hint alone", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "继续" } },
      {
        type: "assistant",
        uuid: "assistant-older-text",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "上一段已经发送过的文字" }],
        },
      },
      {
        type: "user",
        sessionId: "session-a",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "older-tool" }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-tools-only",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/secret" } },
            { type: "tool_use", name: "Grep", input: { pattern: "secret" } },
          ],
        },
      },
    ]);

    // The hint stands alone — the already-sent text above must not come back.
    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toEqual({
      messageId: "assistant-tools-only",
      text: "> 正在并行执行 2 项操作…\n> Read: /secret\n> Grep: secret",
      origin: "local",
    });
  });

  it("skips synthetic placeholder turns and falls back to the real reply", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "问我几个问题" } },
      {
        type: "assistant",
        uuid: "assistant-real",
        sessionId: "session-a",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "好的，我来问你几个问题" }],
        },
      },
      {
        type: "assistant",
        uuid: "assistant-synthetic",
        sessionId: "session-a",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toMatchObject({
      messageId: "assistant-real",
      text: "好的，我来问你几个问题",
    });
  });

  it("skips API error turns", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "继续" } },
      {
        type: "assistant",
        uuid: "assistant-api-error",
        sessionId: "session-a",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [
            { type: "text", text: "There's an issue with the selected model" },
          ],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toBeUndefined();
  });

  it("merges an assistant message split across per-block records", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "继续" } },
      {
        type: "assistant",
        uuid: "block-older-text",
        sessionId: "session-a",
        message: {
          id: "msg_older",
          role: "assistant",
          content: [{ type: "text", text: "上一条消息的文字" }],
        },
      },
      {
        type: "assistant",
        uuid: "block-thinking",
        sessionId: "session-a",
        message: {
          id: "msg_newest",
          role: "assistant",
          content: [{ type: "thinking", thinking: "private" }],
        },
      },
      {
        type: "assistant",
        uuid: "block-text",
        sessionId: "session-a",
        cwd: "/work/pmhq",
        message: {
          id: "msg_newest",
          role: "assistant",
          content: [{ type: "text", text: "我来查一下" }],
        },
      },
      {
        type: "assistant",
        uuid: "block-tool",
        sessionId: "session-a",
        cwd: "/work/pmhq",
        message: {
          id: "msg_newest",
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "secret" } },
          ],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toEqual({
      messageId: "msg_newest",
      text: "我来查一下\n\n> 正在执行命令…\n> secret",
      origin: "local",
      projectDir: "/work/pmhq",
    });
  });

  it("hints activity without merging text from an earlier split message", async () => {
    const transcript = await transcriptFile([
      { type: "user", message: { role: "user", content: "继续" } },
      {
        type: "assistant",
        uuid: "block-older-text",
        sessionId: "session-a",
        message: {
          id: "msg_older",
          role: "assistant",
          content: [{ type: "text", text: "已经发过的文字" }],
        },
      },
      {
        type: "assistant",
        uuid: "block-tool-only",
        sessionId: "session-a",
        message: {
          id: "msg_newest",
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: {} }],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toEqual({
      messageId: "msg_newest",
      text: "> 正在读取文件…",
      origin: "local",
    });
  });

  it("posts the completed response to the authenticated Broker endpoint", async () => {
    const transcript = await transcriptFile([
      {
        type: "custom-title",
        sessionId: "session-a",
        customTitle: "实现远程控制",
      },
      {
        type: "assistant",
        uuid: "assistant-2",
        sessionId: "session-a",
        cwd: "/work/ccrc",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "完成" }],
        },
      },
    ]);
    const fetchMock = vi.fn(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) =>
        new Response(JSON.stringify({ delivered: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      mirrorStopHook(
        {
          hook_event_name: "Stop",
          session_id: "session-a",
          transcript_path: transcript,
        },
        {
          config: config(),
          token: "secret-token",
          fetch: fetchMock as typeof fetch,
        },
      ),
    ).resolves.toEqual({ delivered: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:43921/hooks/assistant-response");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer secret-token",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      sessionId: "session-a",
      messageId: "assistant-2",
      text: "完成",
      origin: "local",
      title: "实现远程控制",
      projectDir: "/work/ccrc",
    });
  });

  it.each([
    "PreToolUse",
    "PostToolUse",
    "SubagentStop",
    "Notification",
    "UserPromptSubmit",
    "SessionEnd",
  ] as const)(
    "posts an in-progress assistant text on %s",
    async (hookEventName) => {
      const transcript = await transcriptFile([
        {
          type: "user",
          sessionId: "session-progress",
          message: { role: "user", content: "开始长任务" },
        },
        {
          type: "assistant",
          uuid: `assistant-${hookEventName}`,
          sessionId: "session-progress",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "阶段性进展" },
              { type: "tool_use", id: "tool-1", name: "Bash", input: {} },
            ],
          },
        },
      ]);
      const fetchMock = vi.fn(
        async (
          _input: Parameters<typeof fetch>[0],
          _init?: Parameters<typeof fetch>[1],
        ) =>
          new Response(JSON.stringify({ delivered: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );

      await expect(
        mirrorStopHook(
          {
            hook_event_name: hookEventName,
            session_id: "session-progress",
            transcript_path: transcript,
            tool_name: "Bash",
          },
          {
            config: config(),
            token: "secret-token",
            fetch: fetchMock as typeof fetch,
          },
        ),
      ).resolves.toEqual({ delivered: true });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
      ).toMatchObject({
        messageId: `assistant-${hookEventName}`,
        text: "阶段性进展\n\n> 正在执行命令…",
      });
    },
  );

  it("recognizes a Channel-wrapped user turn as external", async () => {
    const transcript = await transcriptFile([
      {
        type: "user",
        sessionId: "session-a",
        message: {
          role: "user",
          content:
            '<channel source="ccrc" route_id="route-1" platform="qqbot">\n你好\n</channel>',
        },
      },
      {
        type: "assistant",
        uuid: "assistant-3",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "你好！" }],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toMatchObject({ origin: "external" });
  });

  it("recognizes the user-first CCRC context marker as external", async () => {
    const transcript = await transcriptFile([
      {
        type: "user",
        sessionId: "session-a",
        message: {
          role: "user",
          content:
            '帮我检查测试\n\n<ccrc_context route_id="route-2" platform="qqbot" />',
        },
      },
      {
        type: "assistant",
        uuid: "assistant-4",
        sessionId: "session-a",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "测试通过。" }],
        },
      },
    ]);

    await expect(
      readLastAssistantResponse(transcript, "session-a"),
    ).resolves.toMatchObject({ origin: "external" });
  });
});

async function transcriptFile(records: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ccrc-stop-hook-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  await writeFile(
    path,
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  return path;
}

function config(): ClaudeCodeRemoteControlConfig {
  return {
    broker: {
      host: "127.0.0.1",
      port: 43921,
      autoStart: true,
      mirrorLocalReplies: true,
    },
    platforms: [],
  };
}
