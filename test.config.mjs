import esbuild from "esbuild";
import { unlink } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const outfile = `/tmp/obsidian-encrypted-sync-test-${process.pid}.mjs`;
try {
  await esbuild.build({
    stdin: {
      contents: process.env.SYNC_INTEGRATION
        ? 'import "./tests/sync.test.ts";'
        : 'import "./tests/core.test.ts"; import "./tests/notifications.test.ts";',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "ts"
    },
    alias: { obsidian: new URL("./tests/obsidian.ts", import.meta.url).pathname },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile
  });
  await import(`${pathToFileURL(outfile).href}?run=${Date.now()}`);
} finally {
  await unlink(outfile).catch(() => undefined);
}
