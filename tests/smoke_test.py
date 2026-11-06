"""End-to-end smoke test in headless Chromium (Playwright).

Serves web/ locally and intercepts every third-party request with schema-correct synthetic responses,
so the full UI (selection, auto-zoom, all dossier tabs, State ranking, layers, swipe, export, mobile
layout) is exercised without network access. Fixtures are test doubles only; the app itself never
fabricates data.

Run:  python tests/smoke_test.py [--shots DIR]
"""
from __future__ import annotations

import argparse
import datetime as dt
import functools
import http.server
import io
import json
import math
import socketserver
import struct
import sys
import threading
import zlib
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1] / "web"


def png(w, h, rgba_fn):
    raw = b"".join(b"\x00" + b"".join(bytes(rgba_fn(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


BLANK = png(1, 1, lambda x, y: (0, 0, 0, 0))
FAIL_REST = False  # set for the mobile pass to exercise the SoilGrids WMS fallback


def terrarium(x, y):  # synthetic ridge: 200..1200 m
    h = 700 + 500 * math.sin(x / 40.0) * math.cos(y / 55.0) + 32768
    r, g = int(h // 256), int(h % 256)
    return (r, g, 0, 255)


TERRA = png(256, 256, terrarium)


def ist_hours(past_days, days):
    start = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) + dt.timedelta(hours=5.5)
    start = start.replace(minute=0, second=0, microsecond=0, hour=0) - dt.timedelta(days=past_days)
    return [(start + dt.timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(24 * (past_days + days))]


def ndays(start, end):
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    return [(s + dt.timedelta(days=i)).isoformat() for i in range((e - s).days + 1)]


def forecast_one(q, k):
    pd, fd = int(q.get("past_days", ["0"])[0]), int(q.get("forecast_days", ["7"])[0])
    t = ist_hours(pd, fd)
    hourly = {"time": t}
    for v in q.get("hourly", [""])[0].split(","):
        if not v:
            continue
        if v == "temperature_2m":
            hourly[v] = [29 + 6 * math.sin((i % 24 - 9) / 24 * 2 * math.pi) + k * 0.1 for i in range(len(t))]
        elif v == "relative_humidity_2m":
            hourly[v] = [70 - 15 * math.sin((i % 24 - 9) / 24 * 2 * math.pi) for i in range(len(t))]
        elif v == "precipitation":
            hourly[v] = [(2.0 + k * 0.05) if i % 17 == 0 else 0.0 for i in range(len(t))]
        else:
            hourly[v] = [12.0 for _ in t]
    out = {"latitude": 12.9, "longitude": 79.1, "hourly": hourly}
    if "daily" in q:
        days = sorted({x[:10] for x in t})
        out["daily"] = {"time": days, **{v: [float(10 + i) for i, _ in enumerate(days)] for v in q["daily"][0].split(",")}}
    if "current" in q:
        out["current"] = {v: 30.0 for v in q["current"][0].split(",")}
    return out


def air_one(q, k):
    pd, fd = int(q.get("past_days", ["0"])[0]), int(q.get("forecast_days", ["5"])[0])
    t = ist_hours(pd, fd)
    base = {"pm2_5": 48, "pm10": 85, "nitrogen_dioxide": 22, "sulphur_dioxide": 9, "ozone": 70, "carbon_monoxide": 450}
    return {"hourly": {"time": t, **{v: [base.get(v, 10) * (1 + 0.3 * math.sin(i / 7)) + k for i in range(len(t))] for v in q["hourly"][0].split(",")}}}


def fixture(url: str):
    u = urlparse(url)
    q = parse_qs(u.query)
    host = u.netloc
    lats = q.get("latitude", ["0"])[0].split(",")
    if host == "api.open-meteo.com" and u.path.endswith("/elevation"):
        return {"elevation": [100.0 + 7.3 * i for i in range(len(lats))]}
    if host == "api.open-meteo.com":
        r = [forecast_one(q, k) for k in range(len(lats))]
        return r if len(r) > 1 else r[0]
    if host == "air-quality-api.open-meteo.com":
        r = [air_one(q, k) for k in range(len(lats))]
        return r if len(r) > 1 else r[0]
    if host == "archive-api.open-meteo.com":
        days = ndays(q["start_date"][0], q["end_date"][0])
        n = len(days)
        doy = [dt.date.fromisoformat(d).timetuple().tm_yday for d in days]
        tmean = [26 + 4 * math.sin((d - 100) / 365 * 2 * math.pi) + 0.02 * i / 365 for i, d in enumerate(doy)]
        pr = [(25.0 * ((i * 7919) % 11) / 10 if 150 < d < 290 and i % 3 == 0 else (0.5 if i % 13 == 0 else 0.0)) for i, d in enumerate(doy)]
        allv = {"temperature_2m_mean": tmean, "temperature_2m_max": [t + 6 for t in tmean], "temperature_2m_min": [t - 6 for t in tmean], "precipitation_sum": pr,
                "wet_bulb_temperature_2m_max": [t - 2 + 0.01 * (i % 365) / 365 * 40 for i, t in enumerate(tmean)]}
        return {"daily": {"time": days, **{v: allv[v] for v in q["daily"][0].split(",")}}}
    if host == "flood-api.open-meteo.com":
        if "start_date" in q:
            days = ndays(q["start_date"][0], q["end_date"][0])
            one = lambda k: {"latitude": 12.9 + k * 0.01, "longitude": 79.1, "daily": {"time": days, "river_discharge": [(1 + k) * (80 + 600 * max(0, math.sin((i % 365 - 160) / 365 * 2 * math.pi)) ** 3 * (1 + (i // 365) % 5 / 4)) for i in range(len(days))]}}
            r = [one(k) for k in range(len(lats))]
            return r if len(r) > 1 else r[0]
        pd_ = int(q["past_days"][0])
        start = dt.date.today() - dt.timedelta(days=pd_)
        days = [(start + dt.timedelta(days=i)).isoformat() for i in range(pd_ + int(q["forecast_days"][0]))]
        d = {"time": days}
        for v, f in [("river_discharge", 1), ("river_discharge_median", 1), ("river_discharge_min", 0.6), ("river_discharge_max", 1.6), ("river_discharge_p25", 0.85), ("river_discharge_p75", 1.2)]:
            # ensemble statistics exist only for forecast days (Open-Meteo docs)
            d[v] = [None if (v != "river_discharge" and i < pd_) else f * (150 + 3 * i) for i in range(len(days))]
        return {"latitude": 12.95, "longitude": 79.05, "daily": d}
    if host == "maps.isric.org" and q.get("REQUEST", [""])[0] == "GetFeatureInfo":
        base = {"clay": 280, "sand": 450, "silt": 270, "soc": 95, "phh2o": 68, "bdod": 145, "cec": 210, "nitrogen": 110}
        out = "GetFeatureInfo results:\n"
        for j, lyr in enumerate(q["QUERY_LAYERS"][0].split(",")):
            prop = lyr.split("_")[0]
            out += f"\nLayer '{lyr}'\n  Feature 0: \n    x = '79.05'\n    y = '12.89'\n    value_0 = '{base[prop] + j * 5}'\n    value_list = '{base[prop] + j * 5}'\n"
        return ("text", out)
    if host == "rest.isric.org" and FAIL_REST:
        return ("status", 503)
    if host == "rest.isric.org" and "classification" in u.path:
        return {"wrb_class_name": "Luvisols", "wrb_class_probability": [["Luvisols", 31], ["Vertisols", 22], ["Cambisols", 14]]}
    if host == "rest.isric.org":
        units = {"clay": (10, "%"), "sand": (10, "%"), "silt": (10, "%"), "soc": (10, "g/kg"), "phh2o": (10, "pH"), "bdod": (100, "kg/dm³"), "cec": (10, "cmol(c)/kg"), "nitrogen": (100, "g/kg")}
        val = {"clay": 280, "sand": 450, "silt": 270, "soc": 95, "phh2o": 68, "bdod": 145, "cec": 210, "nitrogen": 110}
        layers = [{"name": p, "unit_measure": {"d_factor": units[p][0], "target_units": units[p][1], "mapped_units": "x"},
                   "depths": [{"label": d, "range": {}, "values": {"mean": val[p] + j * 5, "Q0.05": val[p] * 0.7, "Q0.95": val[p] * 1.3}} for j, d in enumerate(q["depth"])]} for p in q["property"]]
        return {"properties": {"layers": layers}}
    if host == "earthquake.usgs.gov":
        feats = []
        for i in range(600):
            m = round(2.5 + (-math.log(1 - ((i * 0.61803398875) % 1)) / math.log(10)), 1)
            feats.append({"type": "Feature", "properties": {"mag": m, "time": 0 + i * 3_000_000_000, "place": f"synthetic {i}", "url": "https://example.org"},
                          "geometry": {"type": "Point", "coordinates": [79 + (i % 10) * 0.1, 12 + (i % 7) * 0.1, 10]}})
        feats.sort(key=lambda f: -f["properties"]["mag"])
        return {"type": "FeatureCollection", "features": feats}
    if host == "eonet.gsfc.nasa.gov":
        return {"events": [{"title": "Synthetic wildfire", "closed": None, "categories": [{"title": "Wildfires"}], "sources": [{"id": "X", "url": "https://example.org"}],
                            "geometry": [{"date": "2026-10-01T00:00:00Z", "type": "Point", "coordinates": [79.1, 12.9]}]}]}
    return None


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=None)
    args = ap.parse_args()
    shots = Path(args.shots) if args.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
    httpd = serve()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/index.html"
    errors, failures = [], []

    def check(cond, msg):
        print(("PASS " if cond else "FAIL ") + msg)
        if not cond:
            failures.append(msg)

    def route(r):
        url = r.request.url
        if url.startswith("http://127.0.0.1"):
            return r.continue_()
        if "elevation-tiles-prod" in url:
            return r.fulfill(status=200, body=TERRA, headers={"Content-Type": "image/png", "Access-Control-Allow-Origin": "*"})
        if "fonts.g" in url:
            return r.fulfill(status=200, body="", headers={"Content-Type": "text/css"})
        if "gibs.earthdata.nasa.gov" in url and "MODIS_Terra_L3_NDVI_16Day" in url:
            return r.fulfill(status=404, body="", headers={"Access-Control-Allow-Origin": "*"})  # simulate a renamed GIBS layer
        fx = fixture(url)
        if isinstance(fx, tuple) and fx[0] == "text":
            return r.fulfill(status=200, body=fx[1], headers={"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"})
        if isinstance(fx, tuple) and fx[0] == "status":
            return r.fulfill(status=fx[1], body="{}", headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
        if fx is not None:
            return r.fulfill(status=200, body=json.dumps(fx), headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
        return r.fulfill(status=200, body=BLANK, headers={"Content-Type": "image/png", "Access-Control-Allow-Origin": "*"})

    with sync_playwright() as p:
        browser = p.chromium.launch()
        global FAIL_REST
        for name, vp in [("desktop", {"width": 1440, "height": 900}), ("mobile", {"width": 390, "height": 844})]:
            FAIL_REST = name == "mobile"
            ctx = browser.new_context(viewport=vp, accept_downloads=True, service_workers="block", device_scale_factor=1)
            page = ctx.new_page()
            page.on("console", lambda m: errors.append(f"[{name}] {m.text}") if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(f"[{name}] pageerror {e}"))
            page.route("**/*", route)
            page.goto(base)
            page.wait_for_function("window.OH && OH.app && OH.app.S.D.length === 785", timeout=20000)
            check(True, f"[{name}] 785 districts loaded")
            check(page.locator("#stateSelect option").count() == 37, f"[{name}] 36 States/UTs in selector")
            if shots:
                page.wait_for_timeout(600)
                page.screenshot(path=str(shots / f"{name}_0_india.png"))

            z0 = page.evaluate("OH.app.S.map.getZoom()")
            page.evaluate("OH.app.selectState('Tamil Nadu')")
            page.wait_for_timeout(1200)
            check(page.evaluate("OH.app.S.map.getZoom()") > z0, f"[{name}] auto-zoom on State")
            check(page.locator("#tabpanels tr[data-lgd]").count() == 38, f"[{name}] Tamil Nadu table has 38 districts")

            page.evaluate("OH.app.setTab('pulse')")
            page.wait_for_selector("#ahpOut table", timeout=20000)
            check(page.locator("#ahpOut tbody tr").count() == 38, f"[{name}] 72-h ranking for 38 districts")
            check(page.locator("#legend .card").count() >= 1, f"[{name}] choropleth legend")
            if shots:
                page.screenshot(path=str(shots / f"{name}_1_state_pulse.png"))

            zs = page.evaluate("OH.app.S.map.getZoom()")
            page.evaluate("OH.app.selectDistrict([...OH.app.S.byLgd.values()].find(f=>f._name==='Vellore'))")
            page.wait_for_timeout(1200)
            check(page.evaluate("OH.app.S.map.getZoom()") > zs, f"[{name}] auto-zoom on district")
            check(page.locator("#dossierTitle").inner_text() == "Vellore", f"[{name}] district dossier title")
            check(page.evaluate("location.hash").startswith("#d=595"), f"[{name}] deep-link hash written")
            for tab in ["overview", "terrain", "soil", "climate", "weather", "air", "rivers", "hazards", "sources"]:
                page.evaluate(f"OH.app.setTab('{tab}')")
                try:
                    page.wait_for_function("!document.querySelector('#tabpanels .skeleton') || document.querySelector('#tabpanels .kv, #tabpanels table')", timeout=30000)
                    page.wait_for_timeout(400)
                except Exception:
                    pass
                if tab == "climate":
                    try:
                        page.wait_for_selector("#chTw", timeout=15000)
                    except Exception:
                        pass
                if tab == "soil":
                    try:
                        page.wait_for_selector("#chTex", timeout=20000)
                    except Exception:
                        pass
                txt = page.locator("#tabpanels").inner_text()
                check("could not be loaded" not in txt and len(txt) > 80, f"[{name}] tab {tab} renders")
                if tab == "soil":
                    check(("map service" in txt) == FAIL_REST and "Clay loam" in txt, f"[{name}] soil via {'WMS fallback' if FAIL_REST else 'REST'}")
                if tab == "climate":
                    check(page.locator("#chTw").count() == 1, f"[{name}] ERA5 humid-heat section")
                if tab == "rivers":
                    p0 = page.evaluate("OH.app.S.point.slice()")
                    page.click("#btnSnap")
                    page.wait_for_timeout(1500)
                    check(page.evaluate("OH.app.S.point")[0] != p0[0] and page.evaluate("OH.app.S.pointUser"), f"[{name}] snap analysis point to largest river")
                    page.wait_for_selector("#chQ", timeout=15000)
                if shots and name == "desktop" and tab in ("terrain", "climate", "rivers", "hazards", "soil"):
                    page.screenshot(path=str(shots / f"{name}_tab_{tab}.png"))

            for oid in ["dem_tint", "wc2021", "soil", "gsw_occ", "ndvi"]:
                page.evaluate(f"(()=>{{const c=document.getElementById('ov-{oid}');c.checked=true;c.dispatchEvent(new Event('change',{{bubbles:true}}));}})()")
            page.wait_for_timeout(1500)
            check(page.evaluate("OH.app.S.overlays.size") == 5, f"[{name}] five overlays active")
            page.wait_for_timeout(1500)
            check(page.evaluate("OH.app.S.overlayState.ndvi.cand") == 1, f"[{name}] GIBS layer falls back to next candidate name")
            check(page.locator("#legend .card").count() >= 4, f"[{name}] overlay legends")
            page.evaluate("(()=>{const c=document.getElementById('ov-dem_slope');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));})()")
            check(page.evaluate("OH.app.S.overlays.has('dem_slope') && !OH.app.S.overlays.has('dem_tint')"), f"[{name}] DEM modes are mutually exclusive")
            page.evaluate("(()=>{const c=document.getElementById('chkSwipe');c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));})()")
            check(page.evaluate("getComputedStyle(OH.app.S.map.getPane('overlays')).clip").startswith("rect"), f"[{name}] swipe clips data layers")
            if shots:
                page.wait_for_timeout(800)
                page.screenshot(path=str(shots / f"{name}_2_layers_swipe.png"))
            page.evaluate("(()=>{const c=document.getElementById('chkSwipe');c.checked=false;c.dispatchEvent(new Event('change',{bubbles:true}));})()")

            page.evaluate("OH.app.setTab('sources')")
            page.wait_for_selector("[data-export=csv]")
            with page.expect_download() as dl:
                page.click("[data-export=csv]") if name == "desktop" else page.evaluate("OH.app.exportData('csv')")
            content = Path(dl.value.path()).read_text(encoding="utf-8-sig")
            check(content.count("\n") > 5 and "Gutenberg-Richter b-value" in content, f"[{name}] CSV of open tabs ({content.count(chr(10))} rows)")
            with page.expect_download(timeout=60000) as dl:
                page.evaluate("OH.app.exportData('all')")
            full = Path(dl.value.path()).read_text(encoding="utf-8-sig")
            sections = {line.split(",")[5] for line in full.splitlines()[1:] if line.count(",") >= 9}
            check({"Geometry", "Terrain", "Soil", "Climate", "Weather", "Air", "Rivers", "Seismicity"} <= sections and "TWx" in full,
                  f"[{name}] full-dossier CSV covers all 8 sections ({full.count(chr(10))} rows)")

            page = ctx.new_page()  # fresh page load, not a hash change
            page.on("pageerror", lambda e: errors.append(f"[{name}] pageerror {e}"))
            page.route("**/*", route)
            page.goto(base + "#d=595&tab=climate&ov=dem_slope")
            try:
                page.wait_for_function("window.OH && OH.app && OH.app.S.selDist && OH.app.S.selDist._name==='Vellore' && OH.app.S.tab==='climate' && OH.app.S.overlays.has('dem_slope')", timeout=20000)
                ok = True
            except Exception:
                ok = False
            check(ok, f"[{name}] deep link on fresh load restores district, tab and layer")
            if shots and name == "mobile":
                page.wait_for_timeout(1500)
                page.screenshot(path=str(shots / f"{name}_3_deeplink.png"))
            ctx.close()
        browser.close()
    httpd.shutdown()
    noise = [e for e in errors if "favicon" not in e and "status of 503" not in e and "status of 404" not in e]  # deliberate failures  # 503 is the deliberate REST failure
    check(not noise, "no console errors" + ("" if not noise else ": " + " | ".join(noise[:6])))
    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
