// Bundles the viewer into index.html + app.js without the Next.js runtime, with the
// sample files inlined into app.js so the pair also works when opened from the file
// system (browsers block fetch() on file:// URLs).
//   npm run build:standalone                       # samples from public/samples
//   SAMPLES_DIR=../other/samples npm run build:standalone
//   DEFAULT_PKG=ES1000122_20260601 npm run build:standalone
// The folder given by SAMPLES_DIR must contain manifest.json listing the files.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const out = resolve("standalone");
const samplesDir = resolve(process.env.SAMPLES_DIR || "public/samples");
const manifest = JSON.parse(readFileSync(join(samplesDir, "manifest.json"), "utf8"));
const samples = {};
for (const n of manifest) {
  if (n === "manifest.json") continue;
  if (!existsSync(join(samplesDir, n))) throw new Error(`listed in manifest but missing: ${n}`);
  samples[n] = readFileSync(join(samplesDir, n), "utf8");
}
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["src/standalone.tsx"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  alias: { "@": resolve("src") },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.NEXT_PUBLIC_DEFAULT_PKG": JSON.stringify(process.env.DEFAULT_PKG || ""),
  },
  banner: { js: `globalThis.__MDRS_SAMPLES__=${JSON.stringify(samples)};` },
  outfile: `${out}/app.js`,
  logLevel: "warning",
});
const css = readFileSync("node_modules/@xyflow/react/dist/style.css", "utf8") + "\n" + readFileSync("src/app/globals.css", "utf8");
const html = `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MDRS Viewer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
${css}
#mdrs-root { height: 100%; }
</style>
<div id="mdrs-root"></div>
<script src="app.js"></script>
`;
writeFileSync(`${out}/index.html`, html);
console.log(`standalone/ written: index.html + app.js with ${Object.keys(samples).length} sample files from ${samplesDir}`);
