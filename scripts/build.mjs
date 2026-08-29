import { build } from "esbuild";
import { chmod, copyFile, mkdir } from "node:fs/promises";

await mkdir("plugin/dist", { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  packages: "bundle",
  logLevel: "info",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/channel/main.ts"],
    outfile: "plugin/dist/channel.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/broker/main.ts"],
    outfile: "plugin/dist/broker.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/cli.ts"],
    outfile: "plugin/dist/cli.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/hooks/stop.ts"],
    outfile: "plugin/dist/stop-hook.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/hooks/ask-user.ts"],
    outfile: "plugin/dist/ask-user-hook.cjs",
  }),
]);

await Promise.all([
  copyFile("config.example.json", "plugin/config.example.json"),
  copyFile("LICENSE", "plugin/LICENSE"),
  chmod("bin/ccrc", 0o755),
]);
