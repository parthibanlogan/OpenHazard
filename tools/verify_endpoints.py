#!/usr/bin/env python3
"""Probe every remote service the app uses and report HTTP status, content type, CORS and latency.

The URL list is read from web/js/config.js through Node, so this check can never drift from the app.
Run from a normal internet connection (and again from an Indian ISP / campus network if users are there):

    python tools/verify_endpoints.py            # markdown table to stdout
    python tools/verify_endpoints.py --json out.json

Exit status is non-zero if any core service (boundaries excluded, they ship with the app) fails.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAT, LON = 12.9165, 79.1325  # Vellore, Tamil Nadu: sample location inside India
ORIGIN = "https://example.github.io"  # any foreign origin, to test CORS


def load_config() -> dict:
    code = ("const c=require(" + json.dumps(str(ROOT / "web/js/config.js")) + ").OH.config;"
            "process.stdout.write(JSON.stringify({OVERLAYS:c.OVERLAYS,BASEMAPS:c.BASEMAPS,API:c.API,GIBS:c.GIBS,ISRIC:c.ISRIC}));")
    return json.loads(subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True).stdout)


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def xyz(url, z=6):
    x, y = tile_xy(LAT, LON, z)
    return url.replace("{s}", "a").replace("{r}", "").replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))


def wms(base, layer):
    d = 0.5
    sep = "&" if "?" in base else "?"
    return (f"{base}{sep}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={layer}&STYLES=&CRS=EPSG:4326"
            f"&BBOX={LAT - d},{LON - d},{LAT + d},{LON + d}&WIDTH=64&HEIGHT=64&FORMAT=image/png&TRANSPARENT=true")


def merc(lat, lon):
    r = 6378137.0
    return r * math.radians(lon), r * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def gibs_wms(base, layer, jpeg=False):
    """The GIBS epsg3857 WMS endpoint, requested in EPSG:3857 exactly as Leaflet does."""
    x0, y0 = merc(LAT - 0.5, LON - 0.5)
    x1, y1 = merc(LAT + 0.5, LON + 0.5)
    fmt = "image/jpeg" if jpeg else "image/png"
    return (f"{base}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS={layer}&STYLES=&SRS=EPSG:3857"
            f"&BBOX={x0:.1f},{y0:.1f},{x1:.1f},{y1:.1f}&WIDTH=64&HEIGHT=64&FORMAT={fmt}&TRANSPARENT={'false' if jpeg else 'true'}")


def probe(name, url, expect, core=True):
    req = urllib.request.Request(url, headers={"User-Agent": "openhazard-india-verify", "Origin": ORIGIN})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            body = r.read(200000)
            ct = r.headers.get("Content-Type", "")
            cors = r.headers.get("Access-Control-Allow-Origin", "")
            ok = r.status == 200 and expect in ct
            return {"name": name, "ok": ok, "status": r.status, "type": ct.split(";")[0], "cors": cors or "-", "bytes": len(body), "ms": int((time.time() - t0) * 1000), "core": core, "url": url}
    except urllib.error.HTTPError as e:
        return {"name": name, "ok": False, "status": e.code, "type": "-", "cors": "-", "bytes": 0, "ms": int((time.time() - t0) * 1000), "core": core, "url": url}
    except Exception as e:  # noqa: BLE001
        return {"name": name, "ok": False, "status": type(e).__name__, "type": "-", "cors": "-", "bytes": 0, "ms": int((time.time() - t0) * 1000), "core": core, "url": url}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    a = ap.parse_args()
    C = load_config()
    checks = []
    for k, b in C["BASEMAPS"].items():
        checks.append((f"basemap {k}", xyz(b["url"]), "image", True))
    for o in C["OVERLAYS"]:
        if o["kind"] == "tile":
            checks.append((o["id"], xyz(o["url"], 6), "image", True))
        elif o["kind"] == "wms":
            checks.append((o["id"], wms(o["url"], o["opts"]["layers"]), "image", True))
        elif o["kind"] == "gibs":
            # every candidate name is probed; the app falls back in this order, so one success is enough
            for j, name in enumerate(o["layers"]):
                url = gibs_wms(C["GIBS"], name, o.get("jpeg"))
                if o.get("fixedTime"):
                    url += f"&TIME={o['fixedTime']}"
                checks.append((f"{o['id']} [{name}]", url, "image", j == 0 and len(o["layers"]) == 1))
        elif o["kind"] == "soil":
            checks.append(("soil clay WMS", wms(C["ISRIC"] + "clay.map", "clay_0-5cm_mean"), "image", True))
            checks.append(("soil WRB WMS", wms(C["ISRIC"] + "wrb.map", "MostProbable"), "image", True))
        elif o["kind"] == "vector":
            checks.append((o["id"], o["url"], "json", True))
    A = C["API"]
    checks += [
        ("DEM terrarium (needs CORS)", xyz(A["terrarium"], 8), "image", True),
        ("elevation", f"{A['elevation']}?latitude={LAT}&longitude={LON}", "json", True),
        ("forecast", f"{A['forecast']}?latitude={LAT}&longitude={LON}&hourly=temperature_2m&forecast_days=1", "json", True),
        ("archive ERA5", f"{A['archive']}?latitude={LAT}&longitude={LON}&start_date=2020-01-01&end_date=2020-01-31&daily=precipitation_sum&models=era5", "json", True),
        ("air quality", f"{A['air']}?latitude={LAT}&longitude={LON}&hourly=pm2_5&forecast_days=1", "json", True),
        ("flood GloFAS", f"{A['flood']}?latitude={LAT}&longitude={LON}&daily=river_discharge,river_discharge_median&forecast_days=3", "json", True),
        ("SoilGrids properties", f"{A['soilProps']}?lon={LON}&lat={LAT}&property=clay&depth=0-5cm&value=mean", "json", True),
        ("SoilGrids WRB", f"{A['soilClass']}?lon={LON}&lat={LAT}&number_classes=3", "json", True),
        ("USGS FDSN", f"{A['fdsn']}?format=geojson&starttime=2020-01-01&minmagnitude=4&minlatitude=8&maxlatitude=37&minlongitude=68&maxlongitude=97&limit=5", "json", True),
        ("NASA EONET", f"{A['eonet']}?status=open&limit=5", "json", True),
    ]
    rows = [probe(*c) for c in checks]
    print("| Service | OK | HTTP | Type | CORS | Bytes | ms |\n|---|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['name']} | {'yes' if r['ok'] else 'NO'} | {r['status']} | {r['type']} | {r['cors']} | {r['bytes']} | {r['ms']} |")
    gibs_ids = {o["id"] for o in C["OVERLAYS"] if o["kind"] == "gibs"}
    for gid in gibs_ids:  # a multi-name GIBS layer fails only if none of its candidates works
        group = [r for r in rows if r["name"].startswith(gid + " [")]
        if group and not any(r["ok"] for r in group):
            for r in group:
                r["core"] = True
    bad = [r for r in rows if r["core"] and not r["ok"]]
    print(f"\n{len(rows) - len(bad)}/{len(rows)} services responded as expected.")
    if a.json:
        Path(a.json).write_text(json.dumps(rows, indent=2))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
