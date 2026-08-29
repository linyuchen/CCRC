export interface ChannelMessageEnvelope {
  routeId: string;
  platform: string;
  text: string;
}

export function formatChannelMessage(message: ChannelMessageEnvelope): string {
  return [
    message.text,
    "",
    `<ccrc_context route_id="${escapeAttribute(message.routeId)}" platform="${escapeAttribute(message.platform)}" />`,
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
