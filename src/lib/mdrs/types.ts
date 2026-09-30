// Core data types for Module Dependency Reference Set (MDRS) analysis.
//
// Key idea: an MDRS row is NOT a dependency between two modules. It is a
// dependency between two *module versions*:
//   (moduleId @ sourceEffectiveTime)  --depends on-->  (referencedComponentId @ targetEffectiveTime)
// Every graph in this tool is therefore built on version nodes, and module-level
// views are only aggregations of those.

export type FileKind = "full" | "snapshot" | "delta" | "json";

export interface MdrsRow {
  id: string;
  effectiveTime: string; // "" when unpublished (Snowstorm JSON)
  active: boolean;
  moduleId: string;
  refsetId: string;
  referencedComponentId: string;
  sourceEffectiveTime: string;
  targetEffectiveTime: string;
  /** Snowstorm JSON only */
  released?: boolean;
  releasedEffectiveTime?: string;
  /** provenance */
  file: string;
  line: number;
}

export interface SourceFile {
  name: string;
  kind: FileKind;
  rows: MdrsRow[];
  /** names discovered in the file (Snowstorm JSON carries pt terms) */
  names?: Record<string, string>;
  warnings: string[];
}

export interface Package {
  key: string;
  label: string;
  files: SourceFile[];
}

export type ViewMode = "full" | "snapshot" | "delta" | "json" | "derived";

export type EdgeStatus = "active" | "retracted";

export interface VersionNode {
  key: string; // `${moduleId}@${et}`
  moduleId: string;
  et: string;
  asSource: boolean;
  asTarget: boolean;
  /** the version is referenced as a target but no MDRS row anywhere in the workspace describes that module version as a source */
  phantom: boolean;
  /** module is described (as source) somewhere, i.e. we know its versions */
  moduleKnown: boolean;
}

export type EdgeFlag =
  | "self"
  | "cycle"
  | "phantom-target"
  | "target-after-source"
  | "et-mismatch"
  | "duplicate-assertion"
  | "ambiguous-target"
  | "unreleased"
  | "repurposed"
  | "redundant"
  | "conflict";

export interface VersionEdge {
  key: string;
  from: string; // node key
  to: string; // node key
  sourceModule: string;
  targetModule: string;
  sourceEt: string;
  targetEt: string;
  status: EdgeStatus;
  rows: MdrsRow[];
  flags: EdgeFlag[];
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  nodes?: string[];
  rowIds?: string[];
}

export type Tier = "int-core" | "int-derivative" | "edition" | "national";

export interface ModuleInfo {
  id: string;
  name: string;
  namespace: string; // "INT" or 7-digit namespace
  tier: Tier;
  depth: number; // 0 = model component (root)
  versions: string[]; // sorted source versions in the view
}

export type ClosurePolicy = "direct-only" | "explicit-closure";
