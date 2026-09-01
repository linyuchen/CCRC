#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { readOrCreateBrokerToken, resolvePaths } from "../core/paths.js";
import type { BrokerMessage, SessionMetadata } from "../core/protocol.js";
import { formatHandoffCommand } from "../core/shell.js";
import { BrokerClient } from "./broker-client.js";
import { formatChannelMessage } from "./channel-message.js";

async function main(): Promise<void> {
  const logger = createLogger(
    "channel",
    process.env.CCRC_LOG_LEVEL === "debug" ? "debug" : "info",
  );
  const paths = resolvePaths();
  const config = await loadConfig(paths);
  const token = await readOrCreateBrokerToken(paths);
  const sessionId =
    process.env.CLAUDE_CODE_SESSION_ID?.trim() ||
    `unidentified-${randomUUID()}`;
  const projectDir = process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const displayName =
    process.env.CCRC_SESSION_NAME?.trim() ||
    `${basename(projectDir) || "Claude"}-${sessionId.slice(0, 8)}`;

  const session: SessionMetadata = {
    id: sessionId,
    projectDir,
    displayName,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };

  const mcp = new Server(
    { name: "ccrc", version: "0.3.10" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
      instructions: [
        'External chat messages contain the user\'s original text first, followed by a private <ccrc_context route_id="..." platform="..." /> marker.',
        "Treat the text before ccrc_context as the user message and never quote or expose the private marker.",
        "Visible assistant text and final responses are mirrored automatically by ClaudeCodeRemoteControl hooks, including responses to local terminal prompts.",
        "Do not call the reply tool for an ordinary final response; use it only to send an additional out-of-band message before the turn ends.",
        "Use the built-in AskUserQuestion tool normally when choices are needed; ClaudeCodeRemoteControl mirrors the native picker to external-platform buttons, and either side can answer first.",
        "Do not expose or invent route IDs.",
      ].join(" "),
    },
  );

  let brokerClient: BrokerClient;

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description:
          "Send an additional out-of-band message to the external conversation before the turn ends. Ordinary final responses are mirrored automatically.",
        inputSchema: {
          type: "object",
          properties: {
            route_id: {
              type: "string",
              description: "The exact route_id from the inbound channel event.",
            },
            text: { type: "string", description: "The response to send." },
          },
          required: ["route_id", "text"],
          additionalProperties: false,
        },
      },
      {
        name: "session_info",
        description:
          "Show this Claude Code session identity and ClaudeCodeRemoteControl broker connection state.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "ask_user",
        description:
          "Legacy direct bridge for one single-choice question. Prefer the built-in AskUserQuestion tool, which the plugin automatically bridges to external-platform buttons.",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question shown to the user.",
            },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 10,
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "A short button label.",
                  },
                  description: {
                    type: "string",
                    description:
                      "Optional explanation shown above the buttons.",
                  },
                },
                required: ["label"],
                additionalProperties: false,
              },
            },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
      },
      {
        name: "prepare_handoff",
        description:
          "Generate the command that resumes this exact Claude Code session with ClaudeCodeRemoteControl enabled.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "reply") {
      const args = z
        .object({ route_id: z.string().min(1), text: z.string().min(1) })
        .parse(request.params.arguments);
      await brokerClient.reply(args.route_id, args.text);
      return { content: [{ type: "text", text: "sent" }] };
    }
    if (request.params.name === "session_info") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ...session, brokerConnected: brokerClient.isConnected() },
              null,
              2,
            ),
          },
        ],
      };
    }
    if (request.params.name === "ask_user") {
      const args = z
        .object({
          question: z.string().trim().min(1).max(1_000),
          options: z
            .array(
              z.object({
                label: z.string().trim().min(1).max(30),
                description: z.string().trim().max(300).optional(),
              }),
            )
            .min(2)
            .max(10),
        })
        .parse(request.params.arguments);
      const answer = await brokerClient.requestChoice({
        requestId: randomUUID(),
        question: args.question,
        options: args.options,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              selectedIndex: answer.selectedIndex,
              label: answer.label,
            }),
          },
        ],
      };
    }
    if (request.params.name === "prepare_handoff") {
      const cliEntry = join(
        dirname(process.argv[1] ?? process.cwd()),
        "cli.cjs",
      );
      const command = formatHandoffCommand(
        process.execPath,
        cliEntry,
        sessionId,
      );
      return {
        content: [
          {
            type: "text",
            text: [
              "当前 Claude 进程不能由 Plugin 原地替换。",
              "请复制下面的命令，退出当前 Claude 后在同一终端执行：",
              "",
              command,
            ].join("\n"),
          },
        ],
      };
    }
    throw new Error(`unknown tool: ${request.params.name}`);
  });

  const PermissionRequestSchema = z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  });

  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    try {
      brokerClient.sendPermissionRequest({
        requestId: params.request_id,
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
      });
    } catch (error) {
      logger.warn("could not forward permission request", {
        error: String(error),
      });
    }
  });

  brokerClient = new BrokerClient(
    config,
    paths,
    token,
    session,
    logger,
    async (message) => {
      await handleBrokerEvent(message);
    },
  );

  await mcp.connect(new StdioServerTransport());
  if (await channelWasEnabledAtStartup()) {
    void brokerClient.start();
  } else {
    logger.info(
      "MCP tools loaded without Channel activation; broker registration skipped",
    );
  }

  async function handleBrokerEvent(message: BrokerMessage): Promise<void> {
    if (message.type === "inbound") {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: formatChannelMessage({
            routeId: message.routeId,
            platform: message.platform,
            text: message.text,
          }),
          meta: {
            route_id: message.routeId,
            platform: message.platform,
            conversation_id: message.conversationId,
            sender_id: message.senderId,
            ...(message.senderName ? { sender_name: message.senderName } : {}),
          },
        },
      });
      return;
    }
    if (message.type === "permission_verdict") {
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: message.requestId, behavior: message.behavior },
      });
    }
  }

  async function channelWasEnabledAtStartup(): Promise<boolean> {
    if (process.env.CCRC_CHANNEL_ACTIVE === "1") return true;
    if (process.env.CCRC_CHANNEL_ACTIVE === "0") return false;
    if (process.platform === "win32") return false;

    // Claude Code does not currently expose channel opt-in to MCP subprocesses.
    // Inspecting the short ancestor chain prevents an ordinary enabled plugin
    // from advertising a session whose notifications Claude would silently drop.
    const exec = promisify(execFile);
    let pid = process.ppid;
    for (let depth = 0; depth < 3 && pid > 1; depth += 1) {
      try {
        const { stdout } = await exec("ps", [
          "-ww",
          "-o",
          "ppid=",
          "-o",
          "command=",
          "-p",
          String(pid),
        ]);
        const match = /^\s*(\d+)\s+(.+)$/s.exec(stdout.trim());
        if (!match) break;
        const command = match[2] ?? "";
        if (
          command.includes("--channels") ||
          command.includes("--dangerously-load-development-channels")
        )
          return true;
        pid = Number(match[1]);
      } catch {
        break;
      }
    }
    return false;
  }

  async function shutdown(): Promise<void> {
    await brokerClient.stop().catch(() => undefined);
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  process.stderr.write(
    `ccrc channel: ${(error as Error).stack ?? String(error)}\n`,
  );
  process.exitCode = 1;
});
