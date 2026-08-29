import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Broker } from "../src/broker/broker.js";
import type { ClaudeCodeRemoteControlConfig } from "../src/core/config.js";
import type { Logger } from "../src/core/logger.js";
import type { BrokerMessage, SessionMetadata } from "../src/core/protocol.js";
import type { ClaudeCodeRemoteControlPaths } from "../src/core/paths.js";
import type {
  InboundHandler,
  InboundMessage,
  PlatformAdapter,
  ReplyTarget,
  SendOptions,
} from "../src/platforms/types.js";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

class FakePlatform implements PlatformAdapter {
  readonly id = "qqbot";
  readonly type = "qqbot";
  handler?: InboundHandler;
  sent: Array<{ target: ReplyTarget; text: string; options?: SendOptions }> =
    [];

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
  }
  async stop(): Promise<void> {}
  async send(
    target: ReplyTarget,
    text: string,
    options?: SendOptions,
  ): Promise<void> {
    this.sent.push({ target, text, ...(options ? { options } : {}) });
  }
  async emit(message: InboundMessage): Promise<void> {
    if (!this.handler) throw new Error("platform is not started");
    await this.handler(message);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("Broker", () => {
  it("routes inbound text to the only online session and sends replies back", async () => {
    const fixture = await createFixture();
    const client = await connectSession(
      fixture.port,
      fixture.token,
      session("session-a", "/work/a"),
    );
    cleanups.push(async () => client.close());

    const inbound = nextMessage(
      client,
      (message) => message.type === "inbound",
    );
    await fixture.platform.emit(externalMessage("请检查项目"));
    const delivered = await inbound;
    expect(delivered).toMatchObject({
      type: "inbound",
      text: "请检查项目",
      platform: "qqbot",
    });
    if (delivered.type !== "inbound")
      throw new Error("expected inbound message");

    const ack = nextMessage(client, (message) => message.type === "ack");
    client.send(
      JSON.stringify({
        type: "reply",
        correlationId: "reply-1",
        routeId: delivered.routeId,
        text: "检查完成",
      }),
    );
    await expect(ack).resolves.toMatchObject({
      type: "ack",
      correlationId: "reply-1",
      ok: true,
    });
    expect(fixture.platform.sent.at(-1)?.text).toBe("检查完成");
  });

  it("lists sessions with number buttons and switches their input target", async () => {
    const fixture = await createFixture();
    const first = await connectSession(
      fixture.port,
      fixture.token,
      session("session-a", "/work/a"),
    );
    const second = await connectSession(
      fixture.port,
      fixture.token,
      session("session-b", "/work/b"),
    );
    cleanups.push(async () => first.close());
    cleanups.push(async () => second.close());

    await fixture.platform.emit(externalMessage("/session", "message-list"));
    const sessionList = fixture.platform.sent.at(-1);
    expect(sessionList?.text).toContain("1. **a-session-a**");
    expect(sessionList?.text).toContain("2. **b-session-b**");
    expect(sessionList?.options?.buttons?.flat()).toMatchObject([
      { label: "1", data: "ccrc:session:session-a" },
      { label: "2", data: "ccrc:session:session-b" },
    ]);

    await fixture.platform.emit({
      ...externalMessage("", "session-button-2"),
      interactionData: "ccrc:session:session-b",
    });
    expect(fixture.platform.sent.at(-1)?.text).toContain(
      "已切换到 **b-session-b**",
    );

    await fixture.platform.emit(externalMessage("/use 1", "message-use"));
    expect(fixture.platform.sent.at(-1)?.text).toContain("`/use` 已废弃");

    const mirrored = await postAssistantResponse(
      fixture.port,
      fixture.token,
      "session-b",
      "local-turn-1",
      "这是终端发起任务的回答",
      "local",
      { title: "修复第二个项目", projectDir: "/work/b" },
    );
    expect(mirrored).toMatchObject({ ok: true, delivered: true });
    expect(fixture.platform.sent.at(-1)?.text).toBe(
      "这是终端发起任务的回答\n\n---\n**会话：** 修复第二个项目\n**目录：** `/work/b`",
    );
    expect(fixture.platform.sent.at(-1)?.target.messageId).toBeUndefined();

    const fromUnselectedSession = await postAssistantResponse(
      fixture.port,
      fixture.token,
      "session-a",
      "local-turn-a",
      "第一个会话也完成了",
      "local",
      { title: "处理第一个项目", projectDir: "/work/a" },
    );
    expect(fromUnselectedSession).toMatchObject({
      ok: true,
      delivered: true,
      deliveredTargets: 1,
    });
    expect(fixture.platform.sent.at(-1)?.text).toContain(
      "**会话：** 处理第一个项目",
    );
    expect(fixture.platform.sent.at(-1)?.text).not.toContain("session-a");

    const fromHookOnlySession = await postAssistantResponse(
      fixture.port,
      fixture.token,
      "session-without-channel",
      "local-turn-hook-only",
      "普通 Claude 会话也完成了",
      "local",
      { title: "未启用 Channel 的会话", projectDir: "/work/plain" },
    );
    expect(fromHookOnlySession).toMatchObject({
      ok: true,
      delivered: true,
      deliveredTargets: 1,
    });
    expect(fixture.platform.sent.at(-1)?.text).toBe(
      "普通 Claude 会话也完成了\n\n---\n**会话：** 未启用 Channel 的会话\n**目录：** `/work/plain`",
    );

    await waitUntil(async () => {
      try {
        const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
          outputTargets?: Record<string, unknown>;
        };
        return Object.keys(state.outputTargets ?? {}).length === 1;
      } catch {
        return false;
      }
    });

    const duplicate = await postAssistantResponse(
      fixture.port,
      fixture.token,
      "session-b",
      "local-turn-1",
      "这是终端发起任务的回答",
      "local",
    );
    expect(duplicate).toMatchObject({
      ok: true,
      delivered: false,
      reason: "duplicate-hook",
    });

    const delivered = nextMessage(
      second,
      (message) => message.type === "inbound",
    );
    await fixture.platform.emit(
      externalMessage("继续第二个项目", "message-task"),
    );
    await expect(delivered).resolves.toMatchObject({
      type: "inbound",
      text: "继续第二个项目",
    });
  });

  it("relays a permission prompt and accepts a verdict only from its conversation", async () => {
    const fixture = await createFixture();
    const client = await connectSession(
      fixture.port,
      fixture.token,
      session("session-a", "/work/a"),
    );
    cleanups.push(async () => client.close());

    const inbound = nextMessage(
      client,
      (message) => message.type === "inbound",
    );
    await fixture.platform.emit(externalMessage("运行测试"));
    await inbound;

    client.send(
      JSON.stringify({
        type: "permission_request",
        requestId: "abcde",
        toolName: "Bash",
        description: "Run tests",
        inputPreview: '{"command":"npm test"}',
      }),
    );
    await waitUntil(() =>
      fixture.platform.sent.some((item) => item.text.includes("abcde")),
    );
    expect(
      fixture.platform.sent.find((item) => item.text.includes("abcde"))?.options
        ?.buttons,
    ).toHaveLength(1);

    const verdict = nextMessage(
      client,
      (message) => message.type === "permission_verdict",
    );
    await fixture.platform.emit(
      externalMessage("yes abcde", "permission-answer"),
    );
    await expect(verdict).resolves.toEqual({
      type: "permission_verdict",
      requestId: "abcde",
      behavior: "allow",
    });
  });

  it("returns a QQ button choice to the Claude session", async () => {
    const fixture = await createFixture();
    const client = await connectSession(
      fixture.port,
      fixture.token,
      session("session-a", "/work/a"),
    );
    cleanups.push(async () => client.close());

    await fixture.platform.emit(externalMessage("/current"));
    client.send(
      JSON.stringify({
        type: "choice_request",
        requestId: "choice-1",
        question: "选择部署环境",
        options: [
          { label: "测试", description: "部署到测试环境" },
          { label: "生产", description: "部署到生产环境" },
        ],
      }),
    );
    await waitUntil(() =>
      fixture.platform.sent.some((item) => item.text.includes("选择部署环境")),
    );
    const prompt = fixture.platform.sent.find((item) =>
      item.text.includes("选择部署环境"),
    );
    expect(prompt?.options?.buttons?.[0]?.[1]).toMatchObject({
      label: "生产",
      data: "ccrc:choice:choice-1:1",
    });

    const result = nextMessage(
      client,
      (message) => message.type === "choice_result",
    );
    await fixture.platform.emit({
      ...externalMessage("", "interaction-1"),
      interactionData: "ccrc:choice:choice-1:1",
      replyTarget: {
        conversationId: "c2c:user",
        senderId: "user",
        context: { messageType: "c2c", userOpenId: "user" },
      },
    });
    await expect(result).resolves.toMatchObject({
      type: "choice_result",
      requestId: "choice-1",
      ok: true,
      selectedIndex: 1,
      label: "生产",
    });
  });

  it("bridges native AskUserQuestion answers through sequential QQ buttons", async () => {
    const fixture = await createFixture();
    await fixture.platform.emit(externalMessage("/current"));

    const answerRequest = postAskUserQuestion(fixture.port, fixture.token, {
      sessionId: "session-native",
      requestId: "tool-use-1",
      projectDir: "/work/native",
      questions: [
        {
          header: "语言",
          question: "你主要使用哪种语言？",
          multiSelect: false,
          options: [
            { label: "Python", description: "脚本和数据分析" },
            { label: "JavaScript/TypeScript", description: "Web 开发" },
          ],
        },
        {
          header: "功能",
          question: "你想测试哪些功能？",
          multiSelect: true,
          options: [{ label: "Markdown 渲染" }, { label: "代码执行" }],
        },
      ],
    });

    await waitUntil(() =>
      fixture.platform.sent.some((item) =>
        item.text.includes("你主要使用哪种语言？"),
      ),
    );
    const firstPrompt = fixture.platform.sent.find((item) =>
      item.text.includes("你主要使用哪种语言？"),
    );
    expect(firstPrompt?.text).toContain("问题 1/2 · 语言");
    expect(firstPrompt?.text).toContain("**目录：** `/work/native`");
    const languageButton = firstPrompt?.options?.buttons
      ?.flat()
      .find((button) => button.data.endsWith(":1"));
    expect(languageButton?.label).toBe("JavaScript/…");
    if (!languageButton) throw new Error("language button was not rendered");

    await fixture.platform.emit({
      ...externalMessage("", "native-choice-1"),
      interactionData: languageButton.data,
    });

    await waitUntil(() =>
      fixture.platform.sent.some((item) =>
        item.text.includes("你想测试哪些功能？"),
      ),
    );
    const secondPrompt = fixture.platform.sent.find((item) =>
      item.text.includes("你想测试哪些功能？"),
    );
    expect(secondPrompt?.text).toContain("可多选");
    const secondButtons = secondPrompt?.options?.buttons?.flat() ?? [];
    const markdownButton = secondButtons.find((button) =>
      button.data.endsWith(":0"),
    );
    const codeButton = secondButtons.find((button) =>
      button.data.endsWith(":1"),
    );
    const doneButton = secondButtons.find((button) =>
      button.data.endsWith(":done"),
    );
    if (!markdownButton || !codeButton || !doneButton)
      throw new Error("multi-select buttons were not rendered");

    await fixture.platform.emit({
      ...externalMessage("", "native-choice-2"),
      interactionData: markdownButton.data,
    });
    await fixture.platform.emit({
      ...externalMessage("", "native-choice-3"),
      interactionData: codeButton.data,
    });
    await fixture.platform.emit({
      ...externalMessage("", "native-choice-done"),
      interactionData: doneButton.data,
    });

    await expect(answerRequest).resolves.toEqual({
      ok: true,
      answers: {
        "你主要使用哪种语言？": "JavaScript/TypeScript",
        "你想测试哪些功能？": "Markdown 渲染, 代码执行",
      },
    });
  });

  it("cancels a pending QQ choice when the native picker wins", async () => {
    const fixture = await createFixture();
    await fixture.platform.emit(externalMessage("/current"));

    const answerRequest = postAskUserQuestion(fixture.port, fixture.token, {
      sessionId: "session-native",
      requestId: "tool-use-local-winner",
      projectDir: "/work/native",
      questions: [
        {
          question: "继续吗？",
          options: [{ label: "继续" }, { label: "取消" }],
        },
        {
          question: "选择环境",
          options: [{ label: "测试" }, { label: "生产" }],
        },
      ],
    });
    await waitUntil(() =>
      fixture.platform.sent.some((item) => item.text.includes("继续吗？")),
    );

    const completion = await postAskUserQuestionCompletion(
      fixture.port,
      fixture.token,
      "session-native",
      { "继续吗？": "继续", 选择环境: "生产" },
    );
    expect(completion).toEqual({ ok: true, canceled: 1 });
    await expect(answerRequest).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("选择已在 Claude 终端完成"),
    });
    await waitUntil(() =>
      fixture.platform.sent.some((item) => item.text.includes("选择已结束")),
    );
    const completionNotice = fixture.platform.sent.find((item) =>
      item.text.includes("选择已结束"),
    );
    expect(completionNotice?.text).toContain(
      "已在 Claude 终端完成，本次 QQ 选择无需再操作。",
    );
    expect(completionNotice?.text).toContain("**继续吗？：** 继续");
    expect(completionNotice?.text).toContain("**选择环境：** 生产");
    expect(completionNotice?.text).toContain("**目录：** `/work/native`");
  });

  it("relays permission buttons from a session not selected by QQ", async () => {
    const fixture = await createFixture();
    const first = await connectSession(
      fixture.port,
      fixture.token,
      session("session-a", "/work/a"),
    );
    const second = await connectSession(
      fixture.port,
      fixture.token,
      session("session-b", "/work/b"),
    );
    cleanups.push(async () => first.close());
    cleanups.push(async () => second.close());
    await fixture.platform.emit(externalMessage("/session"));
    await fixture.platform.emit({
      ...externalMessage("", "session-button-2"),
      interactionData: "ccrc:session:session-b",
    });

    first.send(
      JSON.stringify({
        type: "permission_request",
        requestId: "fghij",
        toolName: "Bash",
        description: "Run tests",
        inputPreview: "npm test",
      }),
    );
    await waitUntil(() =>
      fixture.platform.sent.some((item) => item.text.includes("fghij")),
    );

    const verdict = nextMessage(
      first,
      (message) => message.type === "permission_verdict",
    );
    await fixture.platform.emit({
      ...externalMessage("", "interaction-permission"),
      interactionData: "ccrc:permission:allow:fghij",
      replyTarget: {
        conversationId: "c2c:user",
        senderId: "user",
        context: { messageType: "c2c", userOpenId: "user" },
      },
    });
    await expect(verdict).resolves.toEqual({
      type: "permission_verdict",
      requestId: "fghij",
      behavior: "allow",
    });
  });
});

async function createFixture(): Promise<{
  broker: Broker;
  platform: FakePlatform;
  port: number;
  token: string;
  statePath: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "ccrc-test-"));
  const runtime = join(home, "runtime");
  await mkdir(runtime);
  const paths: ClaudeCodeRemoteControlPaths = {
    home,
    config: join(home, "config.json"),
    runtime,
    token: join(runtime, "broker.token"),
    pid: join(runtime, "broker.pid"),
    state: join(home, "state.json"),
    log: join(home, "broker.log"),
  };
  const port = await freePort();
  const config: ClaudeCodeRemoteControlConfig = {
    broker: {
      host: "127.0.0.1",
      port,
      autoStart: false,
      mirrorLocalReplies: true,
    },
    platforms: [
      {
        type: "qqbot",
        id: "qqbot",
        enabled: true,
        appId: "app",
        appSecret: "secret",
        sandbox: false,
        intents: (1 << 25) | (1 << 26),
        allowedSenders: ["user"],
        allowedConversations: [],
        shareGroupSession: false,
        markdown: false,
      },
    ],
  };
  const platform = new FakePlatform();
  const token = "test-token";
  const broker = new Broker(config, paths, token, logger, () => platform);
  await broker.start();
  cleanups.push(async () => {
    await broker.stop();
    await rm(home, { recursive: true, force: true });
  });
  return { broker, platform, port, token, statePath: paths.state };
}

function session(id: string, projectDir: string): SessionMetadata {
  return {
    id,
    projectDir,
    displayName: `${projectDir.split("/").at(-1)}-${id}`,
    startedAt: new Date().toISOString(),
    pid: 123,
  };
}

function externalMessage(
  text: string,
  messageId = "message-1",
): InboundMessage {
  return {
    platform: "qqbot",
    conversationId: "c2c:user",
    senderId: "user",
    messageId,
    text,
    receivedAt: new Date(),
    replyTarget: {
      conversationId: "c2c:user",
      senderId: "user",
      messageId,
      context: { messageType: "c2c", userOpenId: "user" },
    },
  };
}

async function connectSession(
  port: number,
  token: string,
  metadata: SessionMetadata,
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/channel`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const acknowledged = nextMessage(
    socket,
    (message) => message.type === "hello_ack",
  );
  socket.send(
    JSON.stringify({ type: "hello", protocol: 1, session: metadata }),
  );
  await acknowledged;
  return socket;
}

function nextMessage(
  socket: WebSocket,
  predicate: (message: BrokerMessage) => boolean,
): Promise<BrokerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", listener);
      reject(new Error("timed out waiting for websocket message"));
    }, 2_000);
    const listener = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as BrokerMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("could not allocate port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}

async function postAssistantResponse(
  port: number,
  token: string,
  sessionId: string,
  messageId: string,
  text: string,
  origin: "external" | "local",
  details: { title?: string; projectDir?: string } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://127.0.0.1:${port}/hooks/assistant-response`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, messageId, text, origin, ...details }),
    },
  );
  return (await response.json()) as Record<string, unknown>;
}

async function postAskUserQuestion(
  port: number,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://127.0.0.1:${port}/hooks/ask-user-question`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return (await response.json()) as Record<string, unknown>;
}

async function postAskUserQuestionCompletion(
  port: number,
  token: string,
  sessionId: string,
  answers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://127.0.0.1:${port}/hooks/ask-user-question/complete`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, ...(answers ? { answers } : {}) }),
    },
  );
  return (await response.json()) as Record<string, unknown>;
}
