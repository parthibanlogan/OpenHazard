#!/usr/bin/env python3
"""Fetch, validate and index the LGD district and state boundaries used by OpenHazard India.

Source
    Local Government Directory (LGD, Ministry of Panchayati Raj) boundaries, released CC0 by
    ramSeraph/indian_admin_boundaries and simplified to TopoJSON by yashveeeeeeer/india-geodata
    (scripts/build-map-layers.py, mapshaper). Pinned to a commit so builds are reproducible.

Outputs (web/data/)
    districts.topo.json   TopoJSON, object "districts", properties: name, lgd, census, state, state_lgd
    states.topo.json      TopoJSON, object "states"
    district_index.csv    one row per district: state, district, LGD code, Census-2011 code, bbox,
                          geodesic area (km2, spherical, R = 6 371 008.8 m) and an interior point
    MANIFEST.json         sha256, feature counts, source URLs and build time

Usage
    python tools/build_boundaries.py            # download pinned commit and rebuild
    python tools/build_boundaries.py --check    # validate the files already in web/data
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import sys
import urllib.request
from pathlib import Path

COMMIT = "e4d776828a8fc08ef1204f5ba8f4c5ca53077eda"
BASE = f"https://raw.githubusercontent.com/yashveeeeeeer/india-geodata/{COMMIT}/docs/maps/data"
FILES = {"districts": f"{BASE}/districts.topo.json", "states": f"{BASE}/states.topo.json"}
OUT = Path(__file__).resolve().parents[1] / "web" / "data"
R_EARTH = 6_371_008.8  # mean Earth radius (IUGG), m
EXPECTED_STATES_UTS = 36


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "openhazard-india-build"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def decode_arcs(topo: dict) -> list[list[tuple[float, float]]]:
    """Delta-decode quantized TopoJSON arcs into lon/lat coordinates."""
    t = topo.get("transform")
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for p in arc:
            if t:
                x += p[0]
                y += p[1]
                pts.append((x * t["scale"][0] + t["translate"][0], y * t["scale"][1] + t["translate"][1]))
            else:
                pts.append((p[0], p[1]))
        arcs.append(pts)
    return arcs


def ring_from(idx: list[int], arcs) -> list[tuple[float, float]]:
    ring: list[tuple[float, float]] = []
    for i in idx:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        ring.extend(a if not ring else a[1:])
    return ring


def polygons(geom: dict, arcs) -> list[list[list[tuple[float, float]]]]:
    if geom["type"] == "Polygon":
        return [[ring_from(r, arcs) for r in geom["arcs"]]]
    if geom["type"] == "MultiPolygon":
        return [[ring_from(r, arcs) for r in poly] for poly in geom["arcs"]]
    return []


def ring_area_m2(ring) -> float:
    """Signed spherical polygon area (Chamberlain & Duquette 2007), m2."""
    n = len(ring)
    if n < 4:
        return 0.0
    s = 0.0
    for i in range(n - 1):
        lon1, lat1 = map(math.radians, ring[i])
        lon2, lat2 = map(math.radians, ring[i + 1])
        s += (lon2 - lon1) * (2 + math.sin(lat1) + math.sin(lat2))
    return s * R_EARTH**2 / 2.0


def poly_area_km2(polys) -> float:
    total = 0.0
    for poly in polys:
        outer = abs(ring_area_m2(poly[0]))
        holes = sum(abs(ring_area_m2(h)) for h in poly[1:])
        total += outer - holes
    return total / 1e6


def point_in_ring(x, y, ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_polys(x, y, polys) -> bool:
    for poly in polys:
        if point_in_ring(x, y, poly[0]) and not any(point_in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def interior_point(polys) -> tuple[float, float]:
    """Deterministic interior point: centroid of the largest part if inside it, otherwise the
    grid cell centre inside the largest part farthest from its centroid-free edges (coarse search)."""
    largest = max(polys, key=lambda p: abs(ring_area_m2(p[0])))
    ring = largest[0]
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    if abs(a) > 1e-12:
        cx, cy = cx / (3 * a), cy / (3 * a)
        if point_in_polys(cx, cy, [largest]):
            return cx, cy
    best, best_d = None, -1.0
    n = 40
    for i in range(n):
        for j in range(n):
            x = min(xs) + (i + 0.5) * (max(xs) - min(xs)) / n
            y = min(ys) + (j + 0.5) * (max(ys) - min(ys)) / n
            if not point_in_polys(x, y, [largest]):
                continue
            d = min(math.hypot(x - px, y - py) for px, py in ring)
            if d > best_d:
                best, best_d = (x, y), d
    return best if best else (sum(xs) / len(xs), sum(ys) / len(ys))


def validate(topo: dict, key: str) -> list[dict]:
    if topo.get("type") != "Topology" or key not in topo.get("objects", {}):
        raise SystemExit(f"{key}: not a TopoJSON with object '{key}'")
    geoms = topo["objects"][key]["geometries"]
    ids = [g.get("id") for g in geoms]
    if len(ids) != len(set(ids)):
        raise SystemExit(f"{key}: duplicate feature ids")
    for g in geoms:
        if g["type"] not in ("Polygon", "MultiPolygon"):
            raise SystemExit(f"{key}: unexpected geometry {g['type']} for {g['properties']}")
        if not g["properties"].get("name"):
            raise SystemExit(f"{key}: unnamed feature {g.get('id')}")
    return geoms


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="validate existing files only")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    raw = {}
    for key, url in FILES.items():
        path = OUT / f"{key}.topo.json"
        if args.check:
            raw[key] = path.read_bytes()
        else:
            print(f"downloading {url}")
            raw[key] = fetch(url)
            path.write_bytes(raw[key])

    dtopo = json.loads(raw["districts"])
    stopo = json.loads(raw["states"])
    dgeoms = validate(dtopo, "districts")
    sgeoms = validate(stopo, "states")

    states_from_d = sorted({g["properties"]["state"] for g in dgeoms})
    states = sorted(g["properties"]["name"] for g in sgeoms)
    if len(states_from_d) != EXPECTED_STATES_UTS or len(states) != EXPECTED_STATES_UTS:
        raise SystemExit(f"expected {EXPECTED_STATES_UTS} States/UTs, got {len(states_from_d)} / {len(states)}")
    if set(states_from_d) != set(states):
        raise SystemExit(f"state name mismatch: {set(states_from_d) ^ set(states)}")

    arcs = decode_arcs(dtopo)
    rows = []
    for g in dgeoms:
        p = g["properties"]
        polys = polygons(g, arcs)
        xs = [x for poly in polys for x, _ in poly[0]]
        ys = [y for poly in polys for _, y in poly[0]]
        ix, iy = interior_point(polys)
        if not point_in_polys(ix, iy, polys):
            raise SystemExit(f"interior point outside polygon: {p['name']}")
        rows.append({
            "state": p["state"], "district": p["name"], "lgd_code": p.get("lgd"),
            "census2011_code": p.get("census") or "", "west": round(min(xs), 5), "south": round(min(ys), 5),
            "east": round(max(xs), 5), "north": round(max(ys), 5),
            "area_km2_simplified": round(poly_area_km2(polys), 1),
            "interior_lon": round(ix, 5), "interior_lat": round(iy, 5),
        })
    rows.sort(key=lambda r: (r["state"], r["district"]))
    if args.check:
        print(json.dumps({"districts": len(dgeoms), "states_uts": len(states), "interior_points": "all inside", "status": "ok"}))
        return 0
    with open(OUT / "district_index.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    total_area = sum(r["area_km2_simplified"] for r in rows)
    manifest = {
        "built_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source_commit": COMMIT, "sources": FILES,
        "licence": "CC0 1.0 (LGD boundaries via ramSeraph/indian_admin_boundaries)",
        "districts": len(dgeoms), "states_uts": len(states),
        "sum_district_area_km2_simplified": round(total_area, 0),
        "sha256": {k: hashlib.sha256(v).hexdigest() for k, v in raw.items()},
    }
    (OUT / "MANIFEST.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({k: manifest[k] for k in ("districts", "states_uts", "sum_district_area_km2_simplified")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
