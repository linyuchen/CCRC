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

  it("points at the downloaded copy so the session can open the file", () => {
    expect(
      formatChannelMessage({
        routeId: "route-123",
        platform: "qqbot",
        text: "看看这张图",
        attachments: [
          {
            name: "screenshot.png",
            url: "https://cdn.example/a.png",
            contentType: "image/png",
            path: "/home/me/.ccrc/attachments/ab12-screenshot.png",
          },
        ],
      }),
    ).toBe(
      [
        "看看这张图",
        "",
        "附件：",
        "- screenshot.png [image/png] /home/me/.ccrc/attachments/ab12-screenshot.png",
        "",
        '<ccrc_context route_id="route-123" platform="qqbot" />',
      ].join("\n"),
    );
  });

  it("falls back to the original link when the download failed", () => {
    expect(
      formatChannelMessage({
        routeId: "route-123",
        platform: "qqbot",
        text: "",
        attachments: [{ url: "https://cdn.example/gone.png" }],
      }),
    ).toContain("- 附件 下载失败，原链接：https://cdn.example/gone.png");
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
