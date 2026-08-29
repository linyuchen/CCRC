import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import type { ClaudeCodeRemoteControlPaths } from "../src/core/paths.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("loadConfig", () => {
  it("loads an extensible platform list from JSON", async () => {
    const paths = await testPaths();
    await writeFile(
      paths.config,
      JSON.stringify({
        broker: { port: 45001 },
        platforms: [
          {
            type: "qqbot",
            appId: "id",
            appSecret: "secret",
            allowedSenders: ["owner"],
          },
        ],
      }),
    );
    const config = await loadConfig(paths, {});
    expect(config.broker).toEqual({
      host: "127.0.0.1",
      port: 45001,
      autoStart: true,
      mirrorLocalReplies: true,
    });
    expect(config.platforms[0]).toMatchObject({
      type: "qqbot",
      id: "qqbot",
      appId: "id",
      markdown: true,
    });
  });

  it("rejects environment credentials without a sender allowlist", async () => {
    const paths = await testPaths();
    await expect(
      loadConfig(paths, {
        CCRC_QQ_APP_ID: "id",
        CCRC_QQ_APP_SECRET: "secret",
      }),
    ).rejects.toThrow("CCRC_QQ_ALLOWED_SENDERS");
  });

  it("ignores unresolved plugin placeholders and uses the config file", async () => {
    const paths = await testPaths();
    await writeFile(
      paths.config,
      JSON.stringify({
        platforms: [
          {
            type: "qqbot",
            appId: "file-id",
            appSecret: "file-secret",
            allowedSenders: ["file-owner"],
          },
        ],
      }),
    );
    const config = await loadConfig(paths, {
      CCRC_QQ_APP_ID: "${user_config.qq_app_id}",
      CCRC_QQ_APP_SECRET: "${user_config.qq_app_secret}",
      CCRC_QQ_ALLOWED_SENDERS: "${user_config.qq_allowed_senders}",
    });
    expect(config.platforms[0]).toMatchObject({
      appId: "file-id",
      allowedSenders: ["file-owner"],
    });
  });
});

async function testPaths(): Promise<ClaudeCodeRemoteControlPaths> {
  const home = await mkdtemp(join(tmpdir(), "ccrc-config-"));
  directories.push(home);
  const runtime = join(home, "runtime");
  await mkdir(runtime);
  return {
    home,
    runtime,
    config: join(home, "config.json"),
    token: join(runtime, "broker.token"),
    pid: join(runtime, "broker.pid"),
    state: join(home, "state.json"),
    log: join(home, "broker.log"),
  };
}
