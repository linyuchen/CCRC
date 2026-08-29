import type { Logger } from "../core/logger.js";
import type { PlatformConfig } from "../core/config.js";
import { QQBotAdapter } from "./qqbot.js";
import type { PlatformAdapter } from "./types.js";

export function createPlatformAdapter(
  config: PlatformConfig,
  logger: Logger,
): PlatformAdapter {
  switch (config.type) {
    case "qqbot":
      return new QQBotAdapter(config, logger);
  }
}
