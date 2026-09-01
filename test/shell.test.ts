import { describe, expect, it } from "vitest";
import {
  formatHandoffCommand,
  posixQuote,
  powerShellQuote,
  renderShellInit,
} from "../src/core/shell.js";

const invocation = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  cliEntry: "C:\\Users\\测试用户\\CCRC\\plugin\\dist\\cli.cjs",
  checkoutLauncher: undefined,
};

describe("cross-platform shell commands", () => {
  it("renders a PowerShell wrapper without relying on a Unix shell", () => {
    expect(renderShellInit("powershell", invocation)).toBe(
      [
        "function global:claude {",
        "  & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\测试用户\\CCRC\\plugin\\dist\\cli.cjs' claude @args",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("renders a CMD macro for the current terminal", () => {
    expect(renderShellInit("cmd", invocation)).toBe(
      'doskey claude="C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\测试用户\\CCRC\\plugin\\dist\\cli.cjs" claude $*\n',
    );
  });

  it("renders both native Windows handoff forms", () => {
    expect(
      formatHandoffCommand(
        invocation.nodePath,
        invocation.cliEntry,
        "session-123",
        "win32",
      ),
    ).toBe(
      [
        "PowerShell:",
        "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\测试用户\\CCRC\\plugin\\dist\\cli.cjs' resume 'session-123'",
        "",
        "CMD:",
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\测试用户\\CCRC\\plugin\\dist\\cli.cjs" resume "session-123"',
      ].join("\n"),
    );
  });

  it("escapes apostrophes for POSIX shells and PowerShell independently", () => {
    expect(posixQuote("it's here")).toBe("'it'\\''s here'");
    expect(powerShellQuote("it's here")).toBe("'it''s here'");
  });
});
