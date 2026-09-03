import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAttachments } from "../src/broker/attachments.js";
import type { Logger } from "../src/core/logger.js";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("saveAttachments", () => {
  it("downloads each attachment and reports its local path", async () => {
    const directory = await tempDirectory();
    const fetchMock = vi.fn(async () => body("PNGDATA", "image/png"));

    const saved = await saveAttachments(
      [
        {
          name: "screenshot.png",
          url: "https://cdn.example/a.png",
          contentType: "image/png",
        },
      ],
      directory,
      logger,
      fetchMock as unknown as typeof fetch,
    );

    const path = saved[0]?.path;
    expect(path).toBeDefined();
    expect(path).toContain("screenshot.png");
    await expect(readFile(path as string, "utf8")).resolves.toBe("PNGDATA");
    // The original fields survive so a failed hop can still fall back to them.
    expect(saved[0]).toMatchObject({
      name: "screenshot.png",
      url: "https://cdn.example/a.png",
      contentType: "image/png",
    });
  });

  it("lets the bytes settle an extension the sender got wrong", async () => {
    const directory = await tempDirectory();
    // What QQ actually sends: a .png name labelled image/jpeg, holding a JPEG.
    const jpeg = Buffer.concat([
      Buffer.from("ffd8ff", "hex"),
      Buffer.from("payload"),
    ]);
    const fetchMock = vi.fn(
      async () => new Response(jpeg, { status: 200 }),
    ) as unknown as typeof fetch;

    const saved = await saveAttachments(
      [
        {
          name: "34DAF5BD.png",
          url: "https://cdn.example/q.png",
          contentType: "image/jpeg",
        },
      ],
      directory,
      logger,
      fetchMock,
    );

    expect(saved[0]?.path).toMatch(/34DAF5BD\.jpg$/);
    expect(saved[0]?.path).not.toContain(".png");
  });

  it("leaves an extension the bytes agree with alone", async () => {
    const directory = await tempDirectory();
    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from("payload"),
    ]);
    const fetchMock = vi.fn(
      async () => new Response(png, { status: 200 }),
    ) as unknown as typeof fetch;

    const saved = await saveAttachments(
      [{ name: "real.png", url: "https://cdn.example/real", contentType: "" }],
      directory,
      logger,
      fetchMock,
    );

    expect(saved[0]?.path).toMatch(/real\.png$/);
  });

  it("keeps the attachment untouched when the download fails", async () => {
    const directory = await tempDirectory();
    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));

    const saved = await saveAttachments(
      [{ url: "https://cdn.example/gone.png" }],
      directory,
      logger,
      fetchMock as unknown as typeof fetch,
    );

    expect(saved[0]?.path).toBeUndefined();
    expect(saved[0]?.url).toBe("https://cdn.example/gone.png");
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("refuses an attachment larger than the size cap", async () => {
    const directory = await tempDirectory();
    const fetchMock = vi.fn(
      async () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": String(64 * 1024 * 1024) },
        }),
    );

    const saved = await saveAttachments(
      [{ url: "https://cdn.example/huge.bin" }],
      directory,
      logger,
      fetchMock as unknown as typeof fetch,
    );

    expect(saved[0]?.path).toBeUndefined();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("keeps a hostile filename inside the directory", async () => {
    const directory = await tempDirectory();
    const fetchMock = vi.fn(async () => body("DATA", "text/plain"));

    const saved = await saveAttachments(
      [{ name: "../../etc/passwd", url: "https://cdn.example/x" }],
      directory,
      logger,
      fetchMock as unknown as typeof fetch,
    );

    const entries = await readdir(directory);
    expect(entries).toHaveLength(1);
    expect(saved[0]?.path).toBe(join(directory, entries[0] as string));
    expect(entries[0]).not.toContain("/");
    expect(entries[0]).toContain("passwd");
  });

  it("prunes cached files past their lifetime", async () => {
    const directory = await tempDirectory();
    const stale = join(directory, "stale.bin");
    await writeFile(stale, "old");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(stale, longAgo, longAgo);

    await saveAttachments(
      [{ name: "fresh.txt", url: "https://cdn.example/fresh" }],
      directory,
      logger,
      vi.fn(async () => body("NEW", "text/plain")) as unknown as typeof fetch,
    );

    const entries = await readdir(directory);
    expect(entries).not.toContain("stale.bin");
    expect(entries.some((entry) => entry.includes("fresh.txt"))).toBe(true);
  });
});

function body(content: string, contentType: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(content)),
    },
  });
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ccrc-attachments-"));
  directories.push(directory);
  return directory;
}
