import { describe, expect, it } from "vitest";
import { formatChannelMessage } from "../src/channel/channel-message.js";

describe("channel message envelope", () => {
  it("shows the user text first and keeps the trusted reply route at the end", () => {
    expect(
      formatChannelMessage({
        routeId: "route-123",
        platform: "qqbot",
        text: "输出一段 Markdown",
      }),
    ).toBe(
      '输出一段 Markdown\n\n<ccrc_context route_id="route-123" platform="qqbot" />',
    );
  });

  it("escapes metadata attributes without changing user text", () => {
    expect(
      formatChannelMessage({
        routeId: 'route&"<>',
        platform: "qqbot",
        text: "<keep-user-text>",
      }),
    ).toBe(
      '<keep-user-text>\n\n<ccrc_context route_id="route&amp;&quot;&lt;&gt;" platform="qqbot" />',
    );
  });
});
