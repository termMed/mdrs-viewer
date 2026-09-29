import type { FileKind, MdrsRow, Package, SourceFile } from "./types";

const MDRS_REFSET = "900000000000534007";
const HEADER = [
  "id",
  "effectiveTime",
  "active",
  "moduleId",
  "refsetId",
  "referencedComponentId",
  "sourceEffectiveTime",
  "targetEffectiveTime",
];

const FILE_RE = /ModuleDependency(.*?)(Full|Snapshot|Delta)(.*?)_([^_]+)_(\d{8})\.txt$/i;

export function kindFromName(name: string): FileKind | undefined {
  if (/\.json$/i.test(name)) return "json";
  const m = name.match(FILE_RE);
  if (m) return m[2].toLowerCase() as FileKind;
  if (/full/i.test(name)) return "full";
  if (/snapshot/i.test(name)) return "snapshot";
  if (/delta/i.test(name)) return "delta";
  return undefined;
}

/** Package key/label from an RF2 file name, so a Full and a Snapshot of the same release group together. */
export function packageFromName(name: string): { key: string; label: string } {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = base.match(FILE_RE);
  if (m) {
    const prefix = (m[1] + m[3]).trim();
    const tag = m[4];
    const date = m[5];
    const label = `${prefix ? prefix.replace(/([a-z])([A-Z])/g, "$1 $2") + " " : ""}${tag} ${date}`;
    return { key: `${prefix}${tag}_${date}`, label };
  }
  const stem = base.replace(/\.(txt|json)$/i, "");
  return { key: stem, label: stem.replace(/_/g, " ") };
}

export function parseRf2(text: string, name: string, forcedKind?: FileKind): SourceFile {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  const rows: MdrsRow[] = [];
  let headerSeen = false;
  lines.forEach((raw, idx) => {
    if (!raw.trim()) return;
    const cols = raw.split("\t");
    if (cols[0] === "id") {
      headerSeen = true;
      if (HEADER.some((h, i) => cols[i] !== h)) warnings.push(`Unexpected header at line ${idx + 1}`);
      return;
    }
    if (cols.length < 8) {
      warnings.push(`Line ${idx + 1}: expected 8 columns, found ${cols.length}`);
      return;
    }
    const [id, effectiveTime, active, moduleId, refsetId, referencedComponentId, sourceEffectiveTime, targetEffectiveTime] = cols.map(
      (c) => c.trim(),
    );
    if (refsetId !== MDRS_REFSET) warnings.push(`Line ${idx + 1}: refsetId ${refsetId} is not the MDRS (${MDRS_REFSET})`);
    rows.push({
      id,
      effectiveTime,
      active: active === "1",
      moduleId,
      refsetId,
      referencedComponentId,
      sourceEffectiveTime,
      targetEffectiveTime,
      file: name,
      line: idx + 1,
    });
  });
  if (!headerSeen) warnings.push("No RF2 header row found");
  let kind = forcedKind ?? kindFromName(name);
  if (!kind) {
    // infer: repeated ids => full
    const ids = new Set(rows.map((r) => r.id));
    kind = ids.size < rows.length ? "full" : "snapshot";
    warnings.push(`File type not in name; inferred "${kind}"`);
  }
  return { name, kind, rows, warnings };
}

interface SnowstormMember {
  memberId: string;
  active: boolean;
  moduleId: string;
  refsetId: string;
  referencedComponentId: string;
  effectiveTime?: string;
  released?: boolean;
  releasedEffectiveTime?: number | string;
  additionalFields?: { sourceEffectiveTime?: string; targetEffectiveTime?: string };
  referencedComponent?: { id?: string; conceptId?: string; pt?: { term: string }; fsn?: { term: string } };
}

/** Snowstorm /members JSON (or a bare array of members). Identical duplicate documents are collapsed. */
export function parseSnowstormJson(text: string, name: string): SourceFile {
  const warnings: string[] = [];
  const data = JSON.parse(text);
  const items: SnowstormMember[] = Array.isArray(data) ? data : (data.items ?? []);
  if (!Array.isArray(data) && typeof data.total === "number" && data.total > items.length)
    warnings.push(`JSON holds ${items.length} of ${data.total} members — the export is truncated (raise the 'limit' parameter)`);
  const names: Record<string, string> = {};
  const seen = new Map<string, MdrsRow>();
  let dup = 0;
  items.forEach((m, i) => {
    if (!m || typeof m !== "object" || !m.memberId || !m.moduleId || !m.referencedComponentId) {
      warnings.push(`Item ${i + 1} is not a refset member; skipped`);
      return;
    }
    const rc = m.referencedComponent;
    if (rc?.pt?.term) names[rc.id ?? rc.conceptId ?? m.referencedComponentId] = rc.pt.term;
    const row: MdrsRow = {
      id: m.memberId,
      effectiveTime: m.effectiveTime ?? "",
      active: !!m.active,
      moduleId: m.moduleId,
      refsetId: m.refsetId,
      referencedComponentId: m.referencedComponentId,
      sourceEffectiveTime: m.additionalFields?.sourceEffectiveTime ?? "",
      targetEffectiveTime: m.additionalFields?.targetEffectiveTime ?? "",
      released: m.released,
      releasedEffectiveTime: m.releasedEffectiveTime != null ? String(m.releasedEffectiveTime) : undefined,
      file: name,
      line: i + 1,
    };
    const k = [row.id, row.effectiveTime, row.active, row.sourceEffectiveTime, row.targetEffectiveTime].join("|");
    const prev = seen.get(k);
    if (prev) {
      dup++;
      // keep the released copy
      if (!prev.released && row.released) seen.set(k, row);
      return;
    }
    seen.set(k, row);
  });
  if (dup) warnings.push(`${dup} duplicate member document(s) collapsed (same memberId/effectiveTime returned twice by the API)`);
  const unreleased = [...seen.values()].filter((r) => r.released === false).length;
  if (unreleased) warnings.push(`${unreleased} member(s) flagged released=false`);
  return { name, kind: "json", rows: [...seen.values()], names, warnings };
}

export function parseAny(text: string, name: string): SourceFile {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return parseSnowstormJson(text, name);
  return parseRf2(text, name);
}

/** Group parsed files into packages (Full + Snapshot of the same release belong together). */
export function groupIntoPackages(files: SourceFile[], existing: Package[] = []): Package[] {
  const map = new Map(existing.map((p) => [p.key, { ...p, files: [...p.files] }]));
  for (const f of files) {
    const { key, label } = packageFromName(f.name);
    const pkg = map.get(key) ?? { key, label, files: [] };
    pkg.files = pkg.files.filter((x) => x.kind !== f.kind); // replace same kind
    pkg.files.push(f);
    map.set(key, pkg);
  }
  return [...map.values()];
}
