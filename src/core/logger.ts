export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(
  scope: string,
  minimum: LogLevel = "info",
): Logger {
  const threshold = levels[minimum];
  const write = (
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    if (levels[level] < threshold) return;
    const suffix =
      fields && Object.keys(fields).length > 0
        ? ` ${JSON.stringify(redact(fields))}`
        : "";
    process.stderr.write(
      `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}${suffix}\n`,
    );
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/secret|token|password|credential/i.test(key))
        return [key, "[REDACTED]"];
      return [key, redact(item)];
    }),
  );
}
