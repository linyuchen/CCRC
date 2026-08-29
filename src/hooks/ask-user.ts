#!/usr/bin/env node
import { loadConfig } from "../core/config.js";
import { readOrCreateBrokerToken, resolvePaths } from "../core/paths.js";
import {
  bridgeAskUserQuestion,
  completeAskUserQuestion,
} from "./ask-user-handler.js";

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin());
  const paths = resolvePaths();
  const config = await loadConfig(paths);
  const token = await readOrCreateBrokerToken(paths);
  if (
    input &&
    typeof input === "object" &&
    (input as Record<string, unknown>).hook_event_name === "PostToolUse"
  ) {
    await completeAskUserQuestion(input, { config, token });
    return;
  }
  const output = await bridgeAskUserQuestion(input, { config, token });
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// Any bridge failure intentionally falls back to Claude Code's local picker.
main().catch(() => {
  process.exitCode = 0;
});
