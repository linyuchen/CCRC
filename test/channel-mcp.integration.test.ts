import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("Channel MCP server", () => {
  it("loads safely without channel opt-in and prepares an exact resume handoff", async () => {
    const home = await mkdtemp(join(tmpdir(), "ccrc-mcp-test-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("src/channel/main.ts")],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CCRC_HOME: home,
        CCRC_CHANNEL_ACTIVE: "0",
        CLAUDE_CODE_SESSION_ID: "session-for-handoff",
        CLAUDE_PROJECT_DIR: "/tmp/example-project",
      },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "ccrc-test", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "reply",
        "session_info",
        "ask_user",
        "prepare_handoff",
      ]);

      const result = await client.callTool({
        name: "prepare_handoff",
        arguments: {},
      });
      const text = (
        result.content as Array<{ type: string; text?: string }>
      )[0];
      expect(text?.type).toBe("text");
      if (text?.type === "text")
        expect(text.text).toContain("resume 'session-for-handoff'");
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
