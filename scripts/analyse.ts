import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAny, groupIntoPackages } from "../src/lib/mdrs/parse";
import { buildRegistry, buildGraph } from "../src/lib/mdrs/graph";
import { analyseRows, profilePackage, namesOf } from "../src/lib/mdrs/analysis";

const dir = process.argv[2] ?? "public/samples";
const policy = (process.argv[3] as any) ?? "direct-only";
const files = readdirSync(dir).filter((f) => /\.(txt|json)$/.test(f) && f !== "manifest.json");
const parsed = files.map((f) => parseAny(readFileSync(join(dir, f), "utf8"), f));
const pkgs = groupIntoPackages(parsed);
const reg = buildRegistry(pkgs);
const ws = buildGraph(pkgs.flatMap((p) => p.files.flatMap((f) => f.rows)), reg);
const out: any[] = [];
for (const p of pkgs) {
  const prof = profilePackage(p, reg, policy, ws);
  const views: any = {};
  for (const f of p.files) {
    const a = analyseRows(f.rows, reg, { policy, view: f.kind === "json" ? "json" : f.kind, names: namesOf(p), workspace: ws });
    views[f.kind] = {
      stats: a.stats,
      warnings: f.warnings,
      leaf: a.ownModules,
      modules: [...a.modules.values()].map((m) => ({ id: m.id, name: m.name, depth: m.depth, tier: m.tier, nVersions: m.versions.length, first: m.versions[0], last: m.versions.at(-1) })),
      idStrategies: a.idStrategies,
      moduleEdges: a.moduleEdges,
      findings: a.findings.map((x) => ({ code: x.code, sev: x.severity, title: x.title, detail: x.detail })),
      latestClosures: a.ownModules.map((m) => a.closures.find((c) => c.moduleId === m && c.et === a.modules.get(m)!.versions.at(-1))),
    };
  }
  out.push({ profile: prof, views });
}
console.log(JSON.stringify(out, null, 1));
