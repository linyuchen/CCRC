import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Logger } from "../core/logger.js";
import type { Attachment } from "../platforms/types.js";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Chat platforms hand out short-lived attachment URLs that Claude cannot read
 * on its own, so mirror each one to disk and let the session open the file.
 * A download that fails keeps its attachment untouched — the URL is still a
 * better message than none.
 */
export async function saveAttachments(
  attachments: Attachment[],
  directory: string,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<Attachment[]> {
  if (attachments.length === 0) return attachments;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await pruneAttachments(directory, logger);
  return Promise.all(
    attachments.map((attachment) =>
      saveAttachment(attachment, directory, logger, fetchImpl),
    ),
  );
}

async function saveAttachment(
  attachment: Attachment,
  directory: string,
  logger: Logger,
  fetchImpl: typeof fetch,
): Promise<Attachment> {
  try {
    const response = await fetchImpl(attachment.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    assertWithinLimit(Number(response.headers.get("content-length")));
    const body = Buffer.from(await response.arrayBuffer());
    assertWithinLimit(body.byteLength);
    const path = join(directory, attachmentFilename(attachment, body));
    await writeFile(path, body, { mode: 0o600 });
    return { ...attachment, path };
  } catch (error) {
    logger.warn("failed to download attachment", {
      url: attachment.url,
      error: String(error),
    });
    return attachment;
  }
}

function assertWithinLimit(bytes: number): void {
  if (Number.isFinite(bytes) && bytes > MAX_ATTACHMENT_BYTES)
    throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
}

/**
 * The digest prefix keeps names unique and, because it is always leading hex,
 * makes the result impossible to escape the directory with.
 */
function attachmentFilename(attachment: Attachment, body: Buffer): string {
  const digest = createHash("sha256")
    .update(attachment.url)
    .digest("hex")
    .slice(0, 12);
  const sniffed = sniffExtension(body);
  const name =
    safeBaseName(attachment.name) ||
    `attachment${sniffed ?? extensionFor(attachment.contentType)}`;
  return `${digest}-${retype(name, sniffed)}`;
}

/**
 * QQ hands out a name and a content type that routinely disagree — a `.png`
 * called `image/jpeg`. The bytes are the only honest source, so let them settle
 * the extension while keeping whatever name the sender chose.
 */
function retype(name: string, sniffed: string | undefined): string {
  if (!sniffed) return name;
  const current = extname(name).toLowerCase();
  if (current === sniffed) return name;
  if (sniffed === ".jpg" && current === ".jpeg") return name;
  return `${name.slice(0, name.length - current.length)}${sniffed}`;
}

function sniffExtension(body: Buffer): string | undefined {
  for (const [extension, magic] of FILE_SIGNATURES)
    if (body.subarray(0, magic.length).equals(magic)) return extension;
  if (
    body.subarray(0, 4).toString("latin1") === "RIFF" &&
    body.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return ".webp";
  return undefined;
}

const FILE_SIGNATURES: Array<[string, Buffer]> = [
  [".png", Buffer.from("89504e470d0a1a0a", "hex")],
  [".jpg", Buffer.from("ffd8ff", "hex")],
  [".gif", Buffer.from("GIF8", "latin1")],
  [".pdf", Buffer.from("%PDF-", "latin1")],
  [".zip", Buffer.from("PK", "latin1")],
];

function safeBaseName(name: string | undefined): string {
  if (!name) return "";
  return name
    .replace(/^.*[\\/]/, "")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/^[.]+/, "")
    .slice(0, 80);
}

function extensionFor(contentType: string | undefined): string {
  const subtype = contentType?.split("/")[1]?.split(";")[0]?.trim();
  const extension = subtype?.replace(/[^\p{L}\p{N}]/gu, "");
  return extension ? `.${extension}` : "";
}

async function pruneAttachments(
  directory: string,
  logger: Logger,
): Promise<void> {
  const cutoff = Date.now() - ATTACHMENT_TTL_MS;
  try {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs < cutoff)
        await unlink(path).catch(() => undefined);
    }
  } catch (error) {
    logger.warn("failed to prune attachment cache", { error: String(error) });
  }
}
