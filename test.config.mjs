import esbuild from "esbuild";
import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const outfile = `/tmp/obsidian-encrypted-sync-test-${process.pid}.mjs`;
try {
  await esbuild.build({
    entryPoints: [process.env.SYNC_INTEGRATION ? "tests/sync.test.ts" : "tests/core.test.ts"],
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
