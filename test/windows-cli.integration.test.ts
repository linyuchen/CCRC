import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const windowsIt = process.platform === "win32" ? it : it.skip;

windowsIt("launches an npm-style claude.cmd shim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ccrc windows 测试 "));
  const fakeClaude = join(directory, "claude.cmd");
  const capture = join(directory, "arguments.txt");
  await writeFile(
    fakeClaude,
    [
      "@echo off",
      'if "%~1"=="plugin" if "%~2"=="list" goto plugin_list',
      'echo %*>"%CCRC_TEST_CAPTURE%"',
      "exit /b 0",
      ":plugin_list",
      'echo [{"id":"ccrc@ccrc-local","enabled":true}]',
      "exit /b 0",
      "",
    ].join("\r\n"),
  );

  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "claude", "--model", "sonnet"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CCRC_CLAUDE_BIN: fakeClaude,
          CCRC_TEST_CAPTURE: capture,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect((await readFile(capture, "utf8")).trim()).toBe(
      "--model sonnet --dangerously-load-development-channels plugin:ccrc@ccrc-local",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
