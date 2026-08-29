import { afterEach, describe, expect, it, vi } from "vitest";
import type { QQBotConfig } from "../src/core/config.js";
import type { Logger } from "../src/core/logger.js";
import { QQBotAdapter, splitMessage } from "../src/platforms/qqbot.js";
import type { InboundHandler, InboundMessage } from "../src/platforms/types.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(() => vi.unstubAllGlobals());

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
