#!/usr/bin/env python3
"""Generate the synthetic demo packages shipped in public/samples.

The demo modules (namespace 1000999) are fictitious. They reproduce the
maintenance practices seen in real editions (member id reuse vs a new member
per version, cumulative vs latest-only snapshots, explicit closure, upstream
row redistribution, shared editions) and a set of deliberate defects, so the
explorer can be tried without licensed release files.

    python3 scripts/make_demo_samples.py            # writes public/samples/
"""
import json
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "samples"
REFSET = "900000000000534007"
MODEL, CORE, ICD10 = "900000000000012004", "900000000000207008", "449080006"
SHARED, CTRY_A, CTRY_B, CTRY_B_DRUGS, CTRY_C, CTRY_C_REF = (
    "21000999105", "31000999103", "41000999107", "51000999100", "61000999104", "71000999109")
HEADER = "id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tsourceEffectiveTime\ttargetEffectiveTime"
NS = uuid.UUID("6f1c2a52-7d0e-4c55-9a0b-3b1d2d0e9a11")


def uid(*parts):
    """Deterministic UUID so regenerating gives the same files."""
    return str(uuid.uuid5(NS, "|".join(parts)))


def months(start, end):
    y, m = int(start[:4]), int(start[4:6])
    out = []
    while f"{y}{m:02d}" <= end[:6]:
        out.append(f"{y}{m:02d}01")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


INT_VERSIONS = months("20240101", "20260601")          # monthly International
MAP_VERSIONS = [v for v in INT_VERSIONS if v[4:6] in ("01", "07")]  # ICD-10 map twice a year


def int_before(date):
    return max(v for v in INT_VERSIONS if v < date)


def map_at_or_before(date):
    return max(v for v in MAP_VERSIONS if v <= date)


def row(id_, et, active, mod, target, src, tgt):
    return [id_, et, "1" if active else "0", mod, REFSET, target, src, tgt]


def write(name, rows):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(HEADER + "\n" + "\n".join("\t".join(r) for r in rows) + "\n")


def snapshot(rows):
    latest = {}
    for r in rows:
        if r[0] not in latest or r[1] >= latest[r[0]][1]:
            latest[r[0]] = r
    return list(latest.values())


def int_rows(upto):
    rows = []
    for v in INT_VERSIONS:
        if v > upto:
            continue
        rows.append(row(uid("int", "core-model"), v, True, CORE, MODEL, v, v))
        if v in MAP_VERSIONS:
            rows.append(row(uid("int", "map-core"), v, True, ICD10, CORE, v, v))
            rows.append(row(uid("int", "map-model"), v, True, ICD10, MODEL, v, v))
    return rows


def shared_rows(upto):
    """Shared language edition: new member per version until 2024-10, reused ids after (a hybrid)."""
    rows = []
    for v in ["20240430", "20241031", "20250430", "20251031", "20260430"]:
        if v > upto:
            continue
        base = int_before(v)
        per_version = v <= "20241031"
        key = (lambda t: uid("shared", t, v)) if per_version else (lambda t: uid("shared", t))
        rows.append(row(key("core"), v, True, SHARED, CORE, v, base))
        rows.append(row(key("model"), v, True, SHARED, MODEL, v, base))
        # the map module is only released twice a year, so it drifts from core
        rows.append(row(key("map"), v, True, SHARED, ICD10, v, map_at_or_before(base)))
    return rows


def country_a():
    """SI-style extension: quarterly, reused ids, explicit closure, no upstream rows."""
    rows = []
    for v in ["20240315", "20240615", "20240915", "20241215", "20250315", "20250615",
              "20250915", "20251215", "20260315"]:
        base = int_before(v)
        rows.append(row(uid("A", "core"), v, True, CTRY_A, CORE, v, base))
        rows.append(row(uid("A", "model"), v, True, CTRY_A, MODEL, v, base))
    return rows


def country_b():
    """Extension on the shared edition in the original RF2 style: new member per version, upstream rows included,
    one inconsistent closure (declares a core version different from the one its base requires)."""
    rows = []
    for v in ["20240531", "20241130", "20250531", "20251130", "20260531"]:
        shared = max(s for s in ["20240430", "20241031", "20250430", "20251031", "20260430"] if s < v)
        core = int_before(shared)
        if v == "20251130":
            core = "20250901"  # declared directly; the shared edition 20251031 requires core 20251001
        rows.append(row(uid("B", "shared", v), v, True, CTRY_B, SHARED, v, shared))
        rows.append(row(uid("B", "core", v), v, True, CTRY_B, CORE, v, core))
        rows.append(row(uid("B", "model", v), v, True, CTRY_B, MODEL, v, core))
        if v >= "20250531":  # drugs sub-module declares its parent only: core/model left implied
            rows.append(row(uid("Bd", "B", v), v, True, CTRY_B_DRUGS, CTRY_B, v, v))
    return rows + shared_rows("20260531") + int_rows("20260531")


def country_c_json():
    """Snowstorm members JSON with structural defects."""
    members = []

    def m(mid, et, active, mod, tgt, src, tgte, released=True):
        members.append({
            "memberId": mid, "effectiveTime": et, "active": active, "released": released,
            "moduleId": mod, "refsetId": REFSET, "referencedComponentId": tgt,
            "additionalFields": {"sourceEffectiveTime": src, "targetEffectiveTime": tgte},
        })
    for v in ["20250630", "20251231", "20260630"]:
        base = int_before(v)
        m(uid("C", "core"), v, True, CTRY_C, CORE, v, base)
        m(uid("C", "model"), v, True, CTRY_C, MODEL, v, base)
    # self-dependency and a two-module cycle in the latest release
    m(uid("C", "self"), "20260630", True, CTRY_C, CTRY_C, "20260630", "20260630")
    m(uid("C", "ref"), "20260630", True, CTRY_C, CTRY_C_REF, "20260630", "20260630")
    m(uid("Cr", "C"), "20260630", True, CTRY_C_REF, CTRY_C, "20260630", "20260630")
    m(uid("Cr", "core"), "20260630", True, CTRY_C_REF, CORE, "20260630", "20260601")
    # target later than the source, and a target date that is not a core release
    m(uid("Cr", "old"), "20251231", True, CTRY_C_REF, CTRY_C, "20251231", "20260630")
    m(uid("Cr", "phantom"), "20251231", True, CTRY_C_REF, CORE, "20251231", "20251115")
    # a historical dependency inactivated later, and an unreleased member
    m(uid("C", "retracted"), "20251231", True, CTRY_C, SHARED, "20250630", "20250430")
    m(uid("C", "retracted"), "20260630", False, CTRY_C, SHARED, "20250630", "20250430")
    m(uid("C", "draft"), "20260630", True, CTRY_C, ICD10, "20260630", "20260101", released=False)
    names = {CTRY_C: "Demo country C module", CTRY_C_REF: "Demo country C reference set module"}
    for x in members:
        x["referencedComponent"] = {"id": x["referencedComponentId"], "pt": {"term": names.get(x["referencedComponentId"], "")}}
        if not x["referencedComponent"]["pt"]["term"]:
            del x["referencedComponent"]
    return {"items": members, "total": len(members), "limit": 100, "offset": 0}


def main():
    files = {
        "der2_ssRefset_ModuleDependencyFull_DEMOINT_20260601.txt": int_rows("20260601"),
        "der2_ssRefset_ModuleDependencyFull_DEMOSHARED_20260430.txt": shared_rows("20260430"),
        "der2_ssRefset_ModuleDependencyFull_DEMOA_20260315.txt": country_a(),
        "der2_ssRefset_ModuleDependencyFull_DEMOB_20260531.txt": country_b(),
    }
    for name, rows in files.items():
        write(name, rows)
        write(name.replace("DependencyFull_", "DependencySnapshot_"), snapshot(rows))
    (OUT / "DEMOC_Snowstorm_members.json").write_text(json.dumps(country_c_json(), indent=1))
    listing = sorted(p.name for p in OUT.iterdir() if p.name != "manifest.json")
    (OUT / "manifest.json").write_text(json.dumps(listing, indent=1) + "\n")
    print("\n".join(listing))


if __name__ == "__main__":
    main()
