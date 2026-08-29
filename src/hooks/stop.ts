#!/usr/bin/env node
import { loadConfig } from "../core/config.js";
import { readOrCreateBrokerToken, resolvePaths } from "../core/paths.js";
import { mirrorStopHook } from "./stop-handler.js";

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin());
  const paths = resolvePaths();
  const config = await loadConfig(paths);
  const token = await readOrCreateBrokerToken(paths);
  await mirrorStopHook(input, { config, token });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  if (process.env.CCRC_LOG_LEVEL === "debug")
    process.stderr.write(`ccrc assistant mirror hook: ${String(error)}\n`);
  process.exitCode = 0;
});
