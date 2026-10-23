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
output destination    -> persistent broadcast target for every connected Channel response
```

Selections, aliases, and output destinations survive Broker restarts. Short-lived reply routes do not.

#### Multiple machines, one bot

Each computer runs its own loopback Broker and its own platform connection, so a Broker's registry only ever holds that machine's sessions. To keep independent Brokers from colliding on `1`/`2`, every serial is prefixed with a per-Broker tag. The tag defaults to the machine's hostname and can be overridden with `CCRC_BROKER_TAG` (handy when a hostname is long); if the hostname is unusable it falls back to a stable 2-char hash. So `/session` yields `linyuchen1 linyuchen2` on one machine and `A1 A2` on another that set `CCRC_BROKER_TAG=A`, and selection buttons carry the tag in their callback data (`ccrc:session:<tag>:<id>`):

- A button whose tag matches this Broker selects locally.
- A button tagged for another machine makes this Broker _defer_ the conversation: it stops auto-forwarding plain messages (so a message never lands on two computers at once) and stays silent on `/current`, until the user picks a local session again.

This needs the platform to deliver one chat message to every connected Broker; `/session` and `/list` intentionally answer from each machine so the user sees all of them.

### Platform adapter

Adapters implement `PlatformAdapter` from `src/platforms/types.ts`:

```ts
interface PlatformAdapter {
  readonly id: string;
  readonly type: string;
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  send(target: ReplyTarget, text: string, options?: SendOptions): Promise<void>;
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
- The authenticated `/hooks/assistant-response` endpoint accepts visible progress and final responses only while that session has an active Channel connection, broadcasts them to all persisted output destinations, and deduplicates repeated lifecycle hooks.
- The authenticated `/hooks/ask-user-question` endpoint holds the external racer while the native picker remains interactive. The first side to submit wins; `/hooks/ask-user-question/complete` cancels a still-pending external choice after a native answer.
- Session selection affects inbound routing only. It never filters outbound response broadcasts.
- Permission, native `AskUserQuestion`, and compatibility `ask_user` prompts are also broadcast to the registered output destinations; the first valid response wins.
- QQ renders outgoing text as Markdown and attaches callback keyboards for permissions and choices.
- Single-answer keyboards (permissions, session picks, single-select choices) share a QQ `group_id`, so the first click greys out the rest. Multi-select keyboards omit it: a shared group would lock the remaining options and “完成选择” after the first pick.
- Route IDs expire after 24 hours; permission requests expire after 30 minutes.
- Broker restart preserves session selections but invalidates in-flight reply routes and permissions.
