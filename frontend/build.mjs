// Zero-framework frontend build: bundle TypeScript with esbuild and
// copy static assets into dist/.
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "assets"), { recursive: true });

const options = {
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  format: "esm",
  target: ["es2020"],
  outfile: resolve(dist, "assets/main.js"),
  logLevel: "info",
  sourcemap: false,
};

await cp(resolve(root, "src/style.css"), resolve(dist, "assets/style.css"));
await cp(resolve(root, "index.html"), resolve(dist, "index.html"));

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild watching…");
} else {
  await build(options);
}
