export interface CliInvocation {
  nodePath: string;
  cliEntry: string;
  checkoutLauncher: string | undefined;
}

export function renderShellInit(
  shell: string,
  invocation: CliInvocation,
): string {
  if (shell === "zsh" || shell === "bash") {
    return `claude() { ${posixLauncher(invocation)} claude "$@"; }\n`;
  }
  if (shell === "fish") {
    return `function claude\n  ${posixLauncher(invocation)} claude $argv\nend\n`;
  }
  if (shell === "powershell" || shell === "pwsh") {
    return [
      "function global:claude {",
      `  & ${powerShellQuote(invocation.nodePath)} ${powerShellQuote(invocation.cliEntry)} claude @args`,
      "}",
      "",
    ].join("\n");
  }
  if (shell === "cmd") {
    return `doskey claude=${commandPromptQuote(invocation.nodePath)} ${commandPromptQuote(invocation.cliEntry)} claude $*\n`;
  }
  throw new Error(
    "shell-init supports zsh, bash, fish, powershell, pwsh, or cmd",
  );
}

export function formatHandoffCommand(
  nodePath: string,
  cliEntry: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      "PowerShell:",
      `& ${powerShellQuote(nodePath)} ${powerShellQuote(cliEntry)} resume ${powerShellQuote(sessionId)}`,
      "",
      "CMD:",
      `${commandPromptQuote(nodePath)} ${commandPromptQuote(cliEntry)} resume ${commandPromptQuote(sessionId)}`,
    ].join("\n");
  }
  return `${posixQuote(nodePath)} ${posixQuote(cliEntry)} resume ${posixQuote(sessionId)}`;
}

export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function commandPromptQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function posixLauncher(invocation: CliInvocation): string {
  return invocation.checkoutLauncher
    ? posixQuote(invocation.checkoutLauncher)
    : `${posixQuote(invocation.nodePath)} ${posixQuote(invocation.cliEntry)}`;
}
