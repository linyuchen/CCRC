# Architecture

ClaudeCodeRemoteControl separates platform connectivity from Claude Code's per-session MCP process.

## Components

### Channel client

`src/channel/main.ts` is spawned once for each Claude Code session. It declares:

- `claude/channel` for inbound messages
- `claude/channel/permission` for remote permission decisions
- `reply`, `session_info`, `ask_user`, and `prepare_handoff` MCP tools
- a `PermissionRequest` Hook that races the native `AskUserQuestion` picker against platform buttons
- a `PostToolUse` Hook that cancels a pending platform choice when the native picker wins
- `PreToolUse`, `PostToolUse`, and `Stop` hooks that extract visible assistant text from Claude's transcript; message-ID deduplication lets long tool-using turns stream progress without duplicating their final text

The process reads `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR`, then registers the session with the local Broker. It never owns a platform connection.

### Broker

`src/broker/broker.ts` owns the local session registry and all platform adapters. It listens only on loopback and authenticates every HTTP/WebSocket request with a 256-bit token stored under the ClaudeCodeRemoteControl home directory.

The Broker keeps these mappings:

```text
platform conversation -> selected Claude session
route_id              -> original platform reply target
output destination    -> persistent broadcast target for every session response
```

Selections, aliases, and output destinations survive Broker restarts. Short-lived reply routes do not.

### Platform adapter

Adapters implement `PlatformAdapter` from `src/platforms/types.ts`:

```ts
interface PlatformAdapter {
  readonly id: string
  readonly type: string
  start(handler: InboundHandler): Promise<void>
  stop(): Promise<void>
  send(target: ReplyTarget, text: string, options?: SendOptions): Promise<void>
}
```

An adapter authenticates senders before invoking its inbound handler. The Broker supplies routing and command behavior, so a new platform should not reimplement `/session` or its selection buttons.

To add a platform:

1. Add its config schema to `src/core/config.ts`.
2. Implement `PlatformAdapter` under `src/platforms/`.
3. Extend the factory in `src/platforms/index.ts`.
4. Add protocol-focused tests with a fake transport.

## Wire protocol

The private protocol in `src/core/protocol.ts` uses JSON over a local authenticated WebSocket.

Channel client to Broker:

- `hello`
- `heartbeat`
- `reply`
- `permission_request`
- `choice_request`

Broker to Channel client:

- `hello_ack`
- `inbound`
- `permission_verdict`
- `choice_result`
- `ack`
- `error`

The protocol has an explicit integer version. Additive fields are preferred; bump the version for incompatible changes.

## Delivery semantics

- QQ Gateway messages are deduplicated in memory.
- Claude Channel events are ordered by Claude Code, but the protocol does not provide processing acknowledgements.
- A `reply` waits for the platform API response and returns an acknowledgement to the MCP tool.
- The authenticated `/hooks/assistant-response` endpoint broadcasts visible progress and final responses from every hooked Claude session to all persisted output destinations and deduplicates repeated lifecycle hooks.
- The authenticated `/hooks/ask-user-question` endpoint holds the external racer while the native picker remains interactive. The first side to submit wins; `/hooks/ask-user-question/complete` cancels a still-pending external choice after a native answer.
- Session selection affects inbound routing only. It never filters outbound response broadcasts.
- Permission, native `AskUserQuestion`, and compatibility `ask_user` prompts are also broadcast to the registered output destinations; the first valid response wins.
- QQ renders outgoing text as Markdown and attaches callback keyboards for permissions and choices.
- Route IDs expire after 24 hours; permission requests expire after 30 minutes.
- Broker restart preserves session selections but invalidates in-flight reply routes and permissions.
