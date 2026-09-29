// Bundles the explorer into a single page without the Next.js runtime, for
// publishing as a static demo (e.g. an Artifact) next to the sample files.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve("standalone");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["src/standalone.tsx"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  alias: { "@": resolve("src") },
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: `${out}/app.js`,
  logLevel: "warning",
});
const css = readFileSync("node_modules/@xyflow/react/dist/style.css", "utf8") + "\n" + readFileSync("src/app/globals.css", "utf8");
const html = `<title>MDRS Viewer</title>
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
cpSync("public/samples", `${out}/samples`, { recursive: true });
console.log("standalone/ written");
