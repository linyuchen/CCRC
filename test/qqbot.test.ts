import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QQBotConfig } from "../src/core/config.js";
import type { Logger } from "../src/core/logger.js";
import { QQBotAdapter, splitMessage } from "../src/platforms/qqbot.js";
import type { InboundHandler, InboundMessage } from "../src/platforms/types.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const attachmentDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    attachmentDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("splitMessage", () => {
  it("preserves unicode code points and prefers newline boundaries", () => {
    const chunks = splitMessage(`第一行\n${"🙂".repeat(12)}`, 10);
    expect(chunks.join("")).toBe(`第一行\n${"🙂".repeat(12)}`);
    expect(chunks.every((chunk) => [...chunk].length <= 10)).toBe(true);
  });

  it("sends QQ Markdown with an inline callback keyboard", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, ...(init ? { init } : {}) });
        if (url.includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "access", expires_in: "7200" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: "reply-id" }), {
          status: 200,
        });
      }),
    );

    const config: QQBotConfig = {
      type: "qqbot",
      id: "qqbot",
      enabled: true,
      appId: "app-id",
      appSecret: "secret",
      sandbox: false,
      intents: (1 << 25) | (1 << 26),
      allowedSenders: ["owner"],
      allowedConversations: [],
      shareGroupSession: false,
      markdown: true,
    };
    const adapter = new QQBotAdapter(config, logger);
    await adapter.send(
      {
        conversationId: "c2c:owner",
        senderId: "owner",
        messageId: "incoming-id",
        context: { messageType: "c2c", userOpenId: "owner" },
      },
      "完成",
      {
        buttons: [
          [
            {
              id: "allow-abcde",
              label: "允许",
              visitedLabel: "已允许",
              group: "ccrc-choice",
              data: "ccrc:permission:allow:abcde",
            },
          ],
        ],
      },
    );

    expect(calls[1]?.url).toBe(
      "https://api.sgroup.qq.com/v2/users/owner/messages",
    );
    expect(calls[1]?.init?.headers).toMatchObject({
      authorization: "QQBot access",
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      markdown: { content: "完成" },
      msg_type: 2,
      msg_id: "incoming-id",
      msg_seq: 1,
      keyboard: {
        content: {
          rows: [
            {
              buttons: [
                {
                  id: "allow-abcde",
                  render_data: {
                    label: "允许",
                    visited_label: "已允许",
                    style: 1,
                  },
                  action: {
                    type: 1,
                    data: "ccrc:permission:allow:abcde",
                    permission: { type: 2 },
                    click_limit: 1,
                  },
                  group_id: "ccrc-choice",
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("keeps ungrouped buttons out of a QQ button group", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", stubApi(calls, { id: "reply-id" }));

    const adapter = new QQBotAdapter(qqConfig(), logger);
    await adapter.send(
      {
        conversationId: "c2c:owner",
        senderId: "owner",
        context: { messageType: "c2c", userOpenId: "owner" },
      },
      "可多选",
      {
        buttons: [
          [
            { id: "choice-0", label: "A", data: "ccrc:choice:r:0" },
            { id: "choice-1", label: "B", data: "ccrc:choice:r:1" },
          ],
          [
            {
              id: "choice-done",
              label: "完成选择",
              data: "ccrc:choice:r:done",
            },
          ],
        ],
      },
    );

    // QQ greys out the rest of a group once one button is used, which would
    // leave "完成选择" unclickable after the first pick.
    const body = JSON.parse(String(calls[1]?.init?.body)) as {
      keyboard: { content: { rows: Array<{ buttons: object[] }> } };
    };
    const buttons = body.keyboard.content.rows.flatMap((row) => row.buttons);
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).not.toHaveProperty("group_id");
  });

  it("uploads an attachment for a file_info handle, then sends it as media", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", stubApi(calls, { file_info: "handle-1" }));
    const image = join(await tempDirectory(), "shot.png");
    await writeFile(image, Buffer.from("89504e470d0a1a0a", "hex"));

    const adapter = new QQBotAdapter(qqConfig(), logger);
    await adapter.send(
      {
        conversationId: "c2c:owner",
        senderId: "owner",
        messageId: "incoming-id",
        context: { messageType: "c2c", userOpenId: "owner" },
      },
      "给你图",
      { attachments: [image] },
    );

    // token, text message, upload, media message
    expect(calls).toHaveLength(4);
    expect(calls[2]?.url).toBe(
      "https://api.sgroup.qq.com/v2/users/owner/files",
    );
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      file_type: 1,
      srv_send_msg: false,
      // Without file_name the attachment lands in QQ as "未命名".
      file_name: "shot.png",
      file_data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
    });
    expect(calls[3]?.url).toBe(
      "https://api.sgroup.qq.com/v2/users/owner/messages",
    );
    expect(JSON.parse(String(calls[3]?.init?.body))).toMatchObject({
      msg_type: 7,
      media: { file_info: "handle-1" },
      msg_id: "incoming-id",
      // A fresh sequence, so QQ does not treat it as a repeat of the text.
      msg_seq: 2,
    });
  });

  it("sends an attachment-only reply without an empty text message", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", stubApi(calls, { file_info: "handle-2" }));
    const report = join(await tempDirectory(), "report.pdf");
    await writeFile(report, "%PDF-1.4");

    const adapter = new QQBotAdapter(qqConfig(), logger);
    await adapter.send(
      {
        conversationId: "c2c:owner",
        senderId: "owner",
        context: { messageType: "c2c", userOpenId: "owner" },
      },
      "",
      { attachments: [report] },
    );

    // token, upload, media message — no text message at all.
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining("getAppAccessToken"),
      "https://api.sgroup.qq.com/v2/users/owner/files",
      "https://api.sgroup.qq.com/v2/users/owner/messages",
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      file_type: 4,
      file_name: "report.pdf",
    });
  });

  it("acknowledges a QQ button callback and forwards its data", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, ...(init ? { init } : {}) });
        if (url.includes("getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "access", expires_in: "7200" }),
            { status: 200 },
          );
        }
        return new Response("", { status: 204 });
      }),
    );
    const adapter = new QQBotAdapter(qqConfig(), logger);
    const received: InboundMessage[] = [];
    const testAdapter = adapter as unknown as {
      handler?: InboundHandler;
      handleInteraction(event: unknown): Promise<void>;
    };
    testAdapter.handler = async (message) => {
      received.push(message);
    };

    await testAdapter.handleInteraction({
      id: "interaction-1",
      user_openid: "owner",
      chat_type: 2,
      data: {
        resolved: { button_data: "ccrc:choice:request-1:0" },
      },
    });

    expect(calls[1]?.url).toBe(
      "https://api.sgroup.qq.com/interactions/interaction-1",
    );
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      conversationId: "c2c:owner",
      senderId: "owner",
      interactionData: "ccrc:choice:request-1:0",
    });
  });
});

function qqConfig(): QQBotConfig {
  return {
    type: "qqbot",
    id: "qqbot",
    enabled: true,
    appId: "app-id",
    appSecret: "secret",
    sandbox: false,
    intents: (1 << 25) | (1 << 26),
    allowedSenders: ["owner"],
    allowedConversations: [],
    shareGroupSession: false,
    markdown: true,
  };
}

function stubApi(
  calls: Array<{ url: string; init?: RequestInit }>,
  payload: Record<string, unknown>,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes("getAppAccessToken"))
      return new Response(
        JSON.stringify({ access_token: "access", expires_in: "7200" }),
        { status: 200 },
      );
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ccrc-qq-"));
  attachmentDirectories.push(directory);
  return directory;
}
