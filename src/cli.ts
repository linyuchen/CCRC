#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import crossSpawn from "cross-spawn";
import { loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import {
  ensurePrivateDirectories,
  fileExists,
  readOrCreateBrokerToken,
  resolvePaths,
} from "./core/paths.js";
import { renderShellInit } from "./core/shell.js";
import { brokerHealth, ensureBroker } from "./channel/broker-client.js";

const MARKETPLACE = "ccrc-local";
const PLUGIN_ID = process.env.CCRC_PLUGIN_ID || `ccrc@${MARKETPLACE}`;
const CHANNEL_ENTRY = `plugin:${PLUGIN_ID}`;
const cliEntry = resolve(process.argv[1] ?? process.cwd());
const pluginRoot = join(dirname(cliEntry), "..");
const marketplaceRoot = existsSync(
  join(pluginRoot, ".claude-plugin", "marketplace.json"),
)
  ? pluginRoot
  : join(pluginRoot, "..");
const checkoutLauncher = join(marketplaceRoot, "bin", "ccrc");

async function main(): Promise<number> {
  const [command = "claude", ...args] = process.argv.slice(2);
  if (command === "claude") return launchClaude(args);
  if (command === "resume") {
    const sessionId = args.shift();
    if (!sessionId)
      throw new Error("usage: ccrc resume <session-id> [claude options]");
    return launchClaude(["--resume", sessionId, ...args]);
  }
  if (command === "plugin" && args[0] === "install") return installPlugin();
  if (command === "plugin" && args[0] === "validate") {
    return runClaude([
      "plugin",
      "validate",
      join(pluginRoot, ".claude-plugin", "plugin.json"),
    ]);
  }
  if (command === "broker") return brokerCommand(args);
  if (command === "config") return configCommand(args);
  if (command === "shell-init") {
    return shellInit(
      args[0] ?? (process.platform === "win32" ? "powershell" : "zsh"),
    );
  }
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

async function launchClaude(args: string[]): Promise<number> {
  const hasChannelFlag = args.some(
    (arg) =>
      arg === "--channels" || arg === "--dangerously-load-development-channels",
  );
  if (!hasChannelFlag) {
    const plugin = pluginStatus();
    if (!plugin) {
      throw new Error(
        `Claude plugin ${PLUGIN_ID} is not installed. Run: ccrc plugin install`,
      );
    }
    if (plugin.enabled === false) {
      throw new Error(
        `Claude plugin ${PLUGIN_ID} is installed but disabled. Run: ccrc plugin install`,
      );
    }
  }
  const channelFlag =
    process.env.CCRC_CHANNEL_FLAG === "--channels"
      ? "--channels"
      : "--dangerously-load-development-channels";
  const finalArgs = hasChannelFlag
    ? args
    : [...args, channelFlag, CHANNEL_ENTRY];
  const child = crossSpawn.sync(claudeExecutable(), finalArgs, {
    stdio: "inherit",
    env: { ...process.env, CCRC_CHANNEL_ACTIVE: "1" },
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

function pluginStatus(): { id?: string; enabled?: boolean } | undefined {
  const result = crossSpawn.sync(
    claudeExecutable(),
    ["plugin", "list", "--json"],
    { encoding: "utf8", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return undefined;
  try {
    const plugins = JSON.parse(result.stdout) as Array<{
      id?: string;
      enabled?: boolean;
    }>;
    return plugins.find((plugin) => plugin.id === PLUGIN_ID);
  } catch {
    return undefined;
  }
}

function installPlugin(): number {
  const installed = Boolean(pluginStatus());
  let status = runClaude([
    "plugin",
    "marketplace",
    "add",
    marketplaceRoot,
    "--scope",
    "user",
  ]);
  if (status !== 0) {
    // Adding an already registered local marketplace can fail; update it and
    // continue only if the marketplace is now visible.
    status = runClaude(["plugin", "marketplace", "update", MARKETPLACE]);
    if (status !== 0) return status;
  }
  const installStatus = installed
    ? runClaude(["plugin", "update", PLUGIN_ID, "--scope", "user"])
    : runClaude(["plugin", "install", PLUGIN_ID, "--scope", "user"]);
  if (installStatus !== 0) return installStatus;
  return pluginStatus()?.enabled === false
    ? runClaude(["plugin", "enable", PLUGIN_ID, "--scope", "user"])
    : 0;
}

async function brokerCommand(args: string[]): Promise<number> {
  const action = args[0] ?? "status";
  const paths = resolvePaths();
  await ensurePrivateDirectories(paths);
  const config = await loadConfig(paths);
  const token = await readOrCreateBrokerToken(paths);
  if (action === "start") {
    await ensureBroker(config, paths, token, createLogger("cli"));
    process.stdout.write(
      `ClaudeCodeRemoteControl broker is running on ${config.broker.host}:${config.broker.port}\n`,
    );
    return 0;
  }
  if (action === "status") {
    const health = await brokerRequest(config, token, "/status");
    if (!health) {
      process.stdout.write("ClaudeCodeRemoteControl broker is not running.\n");
      return 1;
    }
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    return 0;
  }
  if (action === "stop") {
    if (!(await stopBroker(config, token))) {
      process.stdout.write("ClaudeCodeRemoteControl broker is not running.\n");
      return 1;
    }
    await unlink(paths.pid).catch(() => undefined);
    process.stdout.write("ClaudeCodeRemoteControl broker is stopping.\n");
    return 0;
  }
  if (action === "restart") {
    await stopBroker(config, token);
    const deadline = Date.now() + 5_000;
    while ((await brokerHealth(config, token)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await ensureBroker(config, paths, token, createLogger("cli"));
    process.stdout.write("ClaudeCodeRemoteControl broker restarted.\n");
    return 0;
  }
  if (action === "logs") {
    process.stdout.write(`${paths.log}\n`);
    return 0;
  }
  throw new Error(`unknown broker command: ${action}`);
}

async function configCommand(args: string[]): Promise<number> {
  const action = args[0] ?? "path";
  const paths = resolvePaths();
  if (action === "path") {
    process.stdout.write(`${paths.config}\n`);
    return 0;
  }
  if (action === "init") {
    await ensurePrivateDirectories(paths);
    if ((await fileExists(paths.config)) && !args.includes("--force")) {
      throw new Error(
        `${paths.config} already exists (pass --force to replace it)`,
      );
    }
    const example = join(pluginRoot, "config.example.json");
    await writeFile(paths.config, await readFile(example), { mode: 0o600 });
    await chmod(paths.config, 0o600).catch(() => undefined);
    process.stdout.write(
      `Created ${paths.config}. Fill in the QQ app credentials and sender allowlist.\n`,
    );
    return 0;
  }
  throw new Error(`unknown config command: ${action}`);
}

async function brokerRequest(
  config: Awaited<ReturnType<typeof loadConfig>>,
  token: string,
  path: string,
): Promise<unknown> {
  if (!(await brokerHealth(config, token))) return undefined;
  const response = await fetch(
    `http://${config.broker.host}:${config.broker.port}${path}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    },
  );
  return response.ok ? response.json() : undefined;
}

async function stopBroker(
  config: Awaited<ReturnType<typeof loadConfig>>,
  token: string,
): Promise<boolean> {
  const response = await fetch(
    `http://${config.broker.host}:${config.broker.port}/shutdown`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    },
  ).catch(() => undefined);
  return Boolean(response?.ok);
}

function run(command: string, args: string[]): number {
  const child = crossSpawn.sync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

function runClaude(args: string[]): number {
  return run(claudeExecutable(), args);
}

function claudeExecutable(): string {
  return process.env.CCRC_CLAUDE_BIN || "claude";
}

function shellInit(shell: string): number {
  process.stdout.write(
    renderShellInit(shell.toLowerCase(), {
      nodePath: process.execPath,
      cliEntry,
      checkoutLauncher: existsSync(checkoutLauncher)
        ? checkoutLauncher
        : undefined,
    }),
  );
  return 0;
}

function printHelp(): void {
  process.stdout
    .write(`ClaudeCodeRemoteControl — route external chat messages to live Claude Code sessions

Usage:
  ccrc                             Start Claude with ClaudeCodeRemoteControl enabled
  ccrc config init                 Create ~/.ccrc/config.json
  ccrc plugin install              Install the local Claude Code plugin
  ccrc claude [options]            Start Claude with ClaudeCodeRemoteControl enabled
  ccrc resume <id>                 Resume a session with ClaudeCodeRemoteControl enabled
  ccrc shell-init <shell>          Print a default-on wrapper (zsh/bash/fish/powershell/cmd)
  ccrc broker status               Show broker, platform, and session status
  ccrc broker start|stop|restart
                                    Manage the local broker
  ccrc broker logs                 Print the broker log path
`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`ccrc: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
