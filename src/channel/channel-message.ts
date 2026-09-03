export interface ChannelAttachment {
  name?: string | undefined;
  url: string;
  contentType?: string | undefined;
  path?: string | undefined;
}

export interface ChannelMessageEnvelope {
  routeId: string;
  platform: string;
  text: string;
  attachments?: ChannelAttachment[];
}

export function formatChannelMessage(message: ChannelMessageEnvelope): string {
  return [
    message.text,
    ...attachmentLines(message.attachments),
    "",
    `<ccrc_context route_id="${escapeAttribute(message.routeId)}" platform="${escapeAttribute(message.platform)}" />`,
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

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
