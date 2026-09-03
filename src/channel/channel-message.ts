export interface ChannelAttachment {
  name?: string | undefined;
  url: string;
  contentType?: string | undefined;
  path?: string | undefined;
}

export interface ChannelMessageEnvelope {
  platform: string;
  text: string;
  attachments?: ChannelAttachment[];
}

/**
 * Claude Code renders this body after a `ccrc:` prefix and flattens it for the
 * preview line, so the user's own words come first and only a short platform
 * tag trails them. The reply route is not repeated here — the host already
 * carries route_id and platform as attributes of the channel event.
 */
export function formatChannelMessage(message: ChannelMessageEnvelope): string {
  return [
    message.text,
    ...attachmentLines(message.attachments),
    "",
    `[${message.platform}]`,
  ].join("\n");
}

function attachmentLines(attachments?: ChannelAttachment[]): string[] {
  if (!attachments || attachments.length === 0) return [];
  return [
    "",
    "附件：",
    ...attachments.map((attachment) => {
      const parts = [`- ${attachment.name ?? "附件"}`];
      if (attachment.contentType) parts.push(`[${attachment.contentType}]`);
      parts.push(
        attachment.path
          ? attachment.path
          : `下载失败，原链接：${attachment.url}`,
      );
      return parts.join(" ");
    }),
  ];
}
