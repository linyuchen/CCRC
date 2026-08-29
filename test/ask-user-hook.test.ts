import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeCodeRemoteControlConfig } from "../src/core/config.js";
import {
  bridgeAskUserQuestion,
  completeAskUserQuestion,
} from "../src/hooks/ask-user-handler.js";

describe("AskUserQuestion hook", () => {
  it("returns QQ answers as a PermissionRequest racer decision", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            answers: { 选择环境: "生产" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const questions = [
      {
        header: "环境",
        question: "选择环境",
        multiSelect: false,
        options: [{ label: "测试" }, { label: "生产" }],
      },
    ];

    await expect(
      bridgeAskUserQuestion(
        {
          session_id: "session-a",
          cwd: "/work/project",
          hook_event_name: "PermissionRequest",
          tool_name: "AskUserQuestion",
          tool_use_id: "tool-1",
          tool_input: { questions },
        },
        {
          config: config(),
          token: "secret-token",
          fetch: fetchMock as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            questions,
            answers: { 选择环境: "生产" },
          },
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:43921/hooks/ask-user-question");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer secret-token",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      sessionId: "session-a",
      requestId: "tool-1",
      projectDir: "/work/project",
      questions,
    });
  });

  it("falls back to Claude's local picker when QQ delivery is unavailable", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"ok":false}', { status: 409 }),
    );
    await expect(
      bridgeAskUserQuestion(
        {
          session_id: "session-a",
          hook_event_name: "PermissionRequest",
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "继续吗？",
                options: [{ label: "继续" }, { label: "取消" }],
              },
            ],
          },
        },
        {
          config: config(),
          token: "secret-token",
          fetch: fetchMock as typeof fetch,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("waits through the native HTTP client without fetch header timeouts", async () => {
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer secret-token");
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: true, answers: { "继续吗？": "继续" } }),
        );
      }, 30);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("could not allocate test port");

    try {
      const output = await bridgeAskUserQuestion(
        {
          session_id: "session-a",
          hook_event_name: "PreToolUse",
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "继续吗？",
                options: [{ label: "继续" }, { label: "取消" }],
              },
            ],
          },
        },
        { config: config(address.port), token: "secret-token" },
      );
      expect(output).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "allow",
          updatedInput: { answers: { "继续吗？": "继续" } },
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("cancels the remote racer after the native picker completes", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"ok":true,"canceled":1}', { status: 200 }),
    );

    await completeAskUserQuestion(
      {
        session_id: "session-a",
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_input: { answers: { "继续吗？": "继续" } },
      },
      {
        config: config(),
        token: "secret-token",
        fetch: fetchMock as typeof fetch,
      },
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:43921/hooks/ask-user-question/complete");
    expect(JSON.parse(String(init?.body))).toEqual({
      sessionId: "session-a",
      answers: { "继续吗？": "继续" },
    });
  });

  it("forwards all native answers from the PostToolUse response", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"ok":true,"canceled":1}', { status: 200 }),
    );

    await completeAskUserQuestion(
      {
        session_id: "session-a",
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "选择环境" }, { question: "启用哪些功能？" }],
        },
        tool_response: {
          answers: {
            选择环境: "生产",
            "启用哪些功能？": "日志, 指标",
          },
        },
      },
      {
        config: config(),
        token: "secret-token",
        fetch: fetchMock as typeof fetch,
      },
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: "session-a",
      answers: {
        选择环境: "生产",
        "启用哪些功能？": "日志, 指标",
      },
    });
  });

  it("extracts multiple answers from Claude's textual tool response", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"ok":true,"canceled":1}', { status: 200 }),
    );

    await completeAskUserQuestion(
      {
        session_id: "session-a",
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "选择环境" }, { question: "启用哪些功能？" }],
        },
        tool_response:
          'Your questions have been answered: "选择环境"="生产", "启用哪些功能？"="日志, 指标". You can now continue with these answers in mind.',
      },
      {
        config: config(),
        token: "secret-token",
        fetch: fetchMock as typeof fetch,
      },
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: "session-a",
      answers: {
        选择环境: "生产",
        "启用哪些功能？": "日志, 指标",
      },
    });
  });
});

function config(port = 43921): ClaudeCodeRemoteControlConfig {
  return {
    broker: {
      host: "127.0.0.1",
      port,
      autoStart: true,
      mirrorLocalReplies: true,
    },
    platforms: [],
  };
}
