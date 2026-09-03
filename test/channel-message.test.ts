import { describe, expect, it } from "vitest";
import { formatChannelMessage } from "../src/channel/channel-message.js";

describe("channel message envelope", () => {
  it("leads with the user text and trails a short platform tag", () => {
    expect(
      formatChannelMessage({
        platform: "qqbot",
        text: "输出一段 Markdown",
      }),
    ).toBe("输出一段 Markdown\n\n[qqbot]");
  });

  it("does not repeat the reply route the host already carries", () => {
    const formatted = formatChannelMessage({
      platform: "qqbot",
      text: "文件名正常显示",
    });
    // The preview line is what the user reads; a route id there just truncates
    // their own words away.
    expect(formatted).not.toContain("route_id");
    expect(formatted.split("\n")[0]).toBe("文件名正常显示");
  });

  it("points at the downloaded copy so the session can open the file", () => {
    expect(
      formatChannelMessage({
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
        "[qqbot]",
      ].join("\n"),
    );
  });

  it("falls back to the original link when the download failed", () => {
    expect(
      formatChannelMessage({
        platform: "qqbot",
        text: "",
        attachments: [{ url: "https://cdn.example/gone.png" }],
      }),
    ).toContain("- 附件 下载失败，原链接：https://cdn.example/gone.png");
  });

  it("keeps user text exactly as written", () => {
    expect(
      formatChannelMessage({
        platform: "qqbot",
        text: '<keep-user-text> & "quotes"',
      }),
    ).toBe('<keep-user-text> & "quotes"\n\n[qqbot]');
  });
});
