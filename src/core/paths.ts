import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeRemoteControlPaths {
  home: string;
  config: string;
  runtime: string;
  token: string;
  pid: string;
  state: string;
  log: string;
  attachments: string;
}

export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCodeRemoteControlPaths {
  const home = env.CCRC_HOME || join(homedir(), ".ccrc");
  const runtime = join(home, "runtime");
  return {
    home,
    config: env.CCRC_CONFIG || join(home, "config.json"),
    runtime,
    token: join(runtime, "broker.token"),
    pid: join(runtime, "broker.pid"),
    state: join(home, "state.json"),
    log: join(home, "broker.log"),
    attachments: join(home, "attachments"),
  };
}

export async function ensurePrivateDirectories(
  paths: ClaudeCodeRemoteControlPaths,
): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700).catch(() => undefined);
  await chmod(paths.runtime, 0o700).catch(() => undefined);
}

export async function readOrCreateBrokerToken(
  paths: ClaudeCodeRemoteControlPaths,
): Promise<string> {
  await ensurePrivateDirectories(paths);
  try {
    return (await readFile(paths.token, "utf8")).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const candidate = randomBytes(32).toString("base64url");
  try {
    const file = await open(
      paths.token,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await file.writeFile(`${candidate}\n`, "utf8");
    await file.close();
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await readFile(paths.token, "utf8")).trim();
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
