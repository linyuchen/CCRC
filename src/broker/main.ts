#!/usr/bin/env node
import { unlink, writeFile } from "node:fs/promises";
import { loadConfig, safeConfigSummary } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import {
  ensurePrivateDirectories,
  readOrCreateBrokerToken,
  resolvePaths,
} from "../core/paths.js";
import { Broker } from "./broker.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  if (command !== "serve")
    throw new Error(`unknown broker command: ${command}`);

  const paths = resolvePaths();
  await ensurePrivateDirectories(paths);
  const config = await loadConfig(paths);
  const token = await readOrCreateBrokerToken(paths);
  const logger = createLogger(
    "broker",
    process.env.CCRC_LOG_LEVEL === "debug" ? "debug" : "info",
  );
  logger.info("configuration loaded", safeConfigSummary(config));

  const broker = new Broker(config, paths, token, logger);
  await broker.start();
  await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("received shutdown signal", { signal });
    await broker
      .stop()
      .catch((error) =>
        logger.error("broker shutdown failed", { error: String(error) }),
      );
    await unlink(paths.pid).catch(() => undefined);
    process.exitCode = 0;
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `ccrc broker: ${(error as Error).stack ?? String(error)}\n`,
  );
  process.exitCode = 1;
});
