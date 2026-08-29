import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { z } from "zod";
import type { ClaudeCodeRemoteControlConfig } from "../core/config.js";

const optionSchema = z.object({
  label: z.string().trim().min(1),
  description: z.string().optional(),
});

const hookInputSchema = z
  .object({
    session_id: z.string().min(1),
    cwd: z.string().min(1).optional(),
    hook_event_name: z.enum(["PreToolUse", "PermissionRequest"]),
    tool_name: z.literal("AskUserQuestion"),
    tool_use_id: z.string().min(1).optional(),
    tool_input: z
      .object({
        questions: z
          .array(
            z.object({
              question: z.string().trim().min(1),
              header: z.string().optional(),
              options: z.array(optionSchema).min(2).max(4),
              multiSelect: z.boolean().optional(),
            }),
          )
          .min(1),
        answers: z.record(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const brokerResponseSchema = z.object({
  ok: z.literal(true),
  answers: z.record(z.string()),
});

const completionInputSchema = z
  .object({
    session_id: z.string().min(1),
    hook_event_name: z.literal("PostToolUse"),
    tool_name: z.literal("AskUserQuestion"),
    tool_input: z
      .object({
        questions: z
          .array(z.object({ question: z.string() }).passthrough())
          .optional(),
        answers: z.record(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    tool_response: z.unknown().optional(),
  })
  .passthrough();

export interface AskUserHookDependencies {
  config: ClaudeCodeRemoteControlConfig;
  token: string;
  fetch?: typeof fetch;
}

export async function bridgeAskUserQuestion(
  rawInput: unknown,
  dependencies: AskUserHookDependencies,
): Promise<Record<string, unknown> | undefined> {
  const input = hookInputSchema.parse(rawInput);
  if (input.tool_input.answers) return undefined;

  const url = `http://${dependencies.config.broker.host}:${dependencies.config.broker.port}/hooks/ask-user-question`;
  const body = {
    sessionId: input.session_id,
    requestId: input.tool_use_id ?? randomUUID(),
    ...(input.cwd ? { projectDir: input.cwd } : {}),
    questions: input.tool_input.questions,
  };
  const rawResult = dependencies.fetch
    ? await postWithFetch(dependencies.fetch, url, dependencies.token, body)
    : await postWithNodeHttp(url, dependencies.token, body);
  if (!rawResult) return undefined;

  const result = brokerResponseSchema.parse(rawResult);
  const updatedInput = {
    ...input.tool_input,
    answers: result.answers,
  };
  if (input.hook_event_name === "PermissionRequest") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput,
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "选择已通过 ClaudeCodeRemoteControl 完成。",
      updatedInput,
    },
  };
}

export async function completeAskUserQuestion(
  rawInput: unknown,
  dependencies: AskUserHookDependencies,
): Promise<void> {
  const input = completionInputSchema.parse(rawInput);
  const url = `http://${dependencies.config.broker.host}:${dependencies.config.broker.port}/hooks/ask-user-question/complete`;
  const answers =
    input.tool_input?.answers ??
    extractAnswers(
      input.tool_response,
      input.tool_input?.questions?.map((question) => question.question) ?? [],
    );
  const body = {
    sessionId: input.session_id,
    ...(answers ? { answers } : {}),
  };
  if (dependencies.fetch) {
    await dependencies.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${dependencies.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
    return;
  }
  await postWithNodeHttp(url, dependencies.token, body, 3_000);
}

function extractAnswers(
  toolResponse: unknown,
  questions: string[],
): Record<string, string> | undefined {
  if (toolResponse && typeof toolResponse === "object") {
    const response = toolResponse as Record<string, unknown>;
    const direct = stringRecord(response.answers);
    if (direct) return direct;
    for (const key of ["result", "content", "output"]) {
      const nested = extractAnswers(response[key], questions);
      if (nested) return nested;
    }
  }
  if (Array.isArray(toolResponse)) {
    for (const item of toolResponse) {
      const nested = extractAnswers(item, questions);
      if (nested) return nested;
    }
  }
  if (typeof toolResponse !== "string" || questions.length === 0)
    return undefined;

  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const marker = `"${question}"="`;
    const start = toolResponse.indexOf(marker);
    if (start < 0) continue;
    const answerStart = start + marker.length;
    const nextQuestion = questions[index + 1];
    const nextMarker = nextQuestion ? `", "${nextQuestion}"="` : undefined;
    const end = nextMarker
      ? toolResponse.indexOf(nextMarker, answerStart)
      : toolResponse.indexOf('". You can now continue', answerStart);
    if (end < 0) continue;
    answers[question] = toolResponse.slice(answerStart, end);
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(([, answer]) => typeof answer !== "string")
  )
    return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

async function postWithFetch(
  request: typeof fetch,
  url: string,
  token: string,
  body: unknown,
): Promise<unknown | undefined> {
  const response = await request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(29 * 60_000),
  });
  return response.ok ? response.json() : undefined;
}

function postWithNodeHttp(
  url: string,
  token: string,
  body: unknown,
  timeoutMs = 29 * 60_000,
): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.once("error", reject);
        response.once("end", () => {
          if (
            response.statusCode === undefined ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error as Error);
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("ClaudeCodeRemoteControl hook timed out"));
    });
    request.once("error", reject);
    request.end(payload);
  });
}
