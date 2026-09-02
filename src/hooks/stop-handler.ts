import { z } from "zod";
import type { ClaudeCodeRemoteControlConfig } from "../core/config.js";
import { readLastAssistantResponse } from "./transcript.js";

// A turn's closing message often carries no tool call, so Stop is its only
// exit — and Stop does not fire when the turn ends waiting on a background
// agent. Mirroring is idempotent (deduped per message id), so every event that
// can mark a turn idle is wired up and the extra firings cost nothing.
const assistantMirrorHookInputSchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().min(1),
    hook_event_name: z.enum([
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SubagentStop",
      "Notification",
      "UserPromptSubmit",
      "SessionEnd",
    ]),
  })
  .passthrough();

export interface StopHookDependencies {
  config: ClaudeCodeRemoteControlConfig;
  token: string;
  fetch?: typeof fetch;
}

export async function mirrorStopHook(
  rawInput: unknown,
  dependencies: StopHookDependencies,
): Promise<{ delivered: boolean; reason?: string }> {
  const input = assistantMirrorHookInputSchema.parse(rawInput);
  const response = await readLastAssistantResponse(
    input.transcript_path,
    input.session_id,
  );
  if (!response) return { delivered: false, reason: "no-assistant-text" };
  if (
    response.origin === "local" &&
    !dependencies.config.broker.mirrorLocalReplies
  )
    return { delivered: false, reason: "local-mirroring-disabled" };

  const request = dependencies.fetch ?? fetch;
  const result = await request(
    `http://${dependencies.config.broker.host}:${dependencies.config.broker.port}/hooks/assistant-response`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${dependencies.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: input.session_id,
        messageId: response.messageId,
        text: response.text,
        origin: response.origin,
        ...(response.title ? { title: response.title } : {}),
        ...(response.projectDir ? { projectDir: response.projectDir } : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!result.ok)
    throw new Error(
      `broker rejected assistant mirror hook with HTTP ${result.status}`,
    );
  return (await result.json()) as { delivered: boolean; reason?: string };
}
