"""Verify web/js/analytics.js and web/js/geo.js against SciPy/NumPy reference implementations.

Run:  python -m pytest -q tests      (or)   python tests/test_analytics.py
Needs Node.js >= 18 on PATH, numpy, scipy.
"""
from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path

import numpy as np
from scipy import stats, special

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "web" / "js"
rng = np.random.default_rng(20261106)


def js(expr: str, data=None):
    """Evaluate `expr` in Node with S = analytics, Gm = geo, D = data; returns JSON."""
    code = (
        f"const S=require({json.dumps(str(JS / 'analytics.js'))});"
        f"const Gm=require({json.dumps(str(JS / 'geo.js'))});"
        f"const D={json.dumps(data)};"
        f"process.stdout.write(JSON.stringify((()=>{{return {expr};}})()));"
    )
    out = subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def close(a, b, tol, label):
    assert abs(a - b) <= tol, f"{label}: {a} vs {b} (tol {tol})"


def test_special_functions():
    z = np.linspace(-5, 5, 41).tolist()
    got = js("D.map(S.normCdf)", z)
    assert np.max(np.abs(np.array(got) - stats.norm.cdf(z))) < 2e-7
    p = [1e-6, 1e-3, 0.02, 0.1, 0.3, 0.5, 0.77, 0.975, 0.999]
    got = js("D.map(S.normInv)", p)
    assert np.max(np.abs(np.array(got) - stats.norm.ppf(p))) < 1e-6
    pairs = [[0.5, 0.1], [1.7, 2.3], [3.2, 10.0], [8.0, 4.0], [25.0, 30.0]]
    got = js("D.map(([a,x])=>S.gammaP(a,x))", pairs)
    ref = [special.gammainc(a, x) for a, x in pairs]
    assert np.max(np.abs(np.array(got) - ref)) < 1e-10
    got = js("D.map(S.lnGamma)", [0.3, 1.5, 7.2, 40.0])
    assert np.max(np.abs(np.array(got) - special.gammaln([0.3, 1.5, 7.2, 40.0]))) < 1e-10


def test_mann_kendall_and_sen():
    t = np.arange(1981, 2026, dtype=float)
    x = 0.021 * (t - t[0]) + rng.normal(0, 0.25, t.size)
    x[5] = x[6]  # introduce a tie
    r = js("S.mannKendall(D.t, D.x)", {"t": t.tolist(), "x": x.tolist()})
    ts = stats.theilslopes(x, t)
    close(r["slope"], ts.slope, 1e-12, "Sen slope")
    tau = stats.kendalltau(t, x)  # tau-b; equals S/(n(n-1)/2) only without ties in x
    # independent S and variance (Kendall 1975, tie-corrected)
    n = x.size
    S = sum(np.sign(x[j] - x[i]) for i in range(n - 1) for j in range(i + 1, n))
    _, counts = np.unique(x, return_counts=True)
    var = (n * (n - 1) * (2 * n + 5) - sum(c * (c - 1) * (2 * c + 5) for c in counts)) / 18
    Z = (S - np.sign(S)) / math.sqrt(var)
    close(r["S"], S, 0, "MK S")
    close(r["Z"], Z, 1e-12, "MK Z")
    close(r["p"], 2 * stats.norm.sf(abs(Z)), 1e-6, "MK p")
    assert tau.pvalue < 0.05 and r["p"] < 0.05


def test_spi_matches_scipy_gamma():
    years = np.repeat(np.arange(1981, 2026), 12)
    months = np.tile(np.arange(1, 13), 45)
    shape = np.where((months >= 6) & (months <= 9), 4.0, 1.2)
    v = rng.gamma(shape, 40.0)
    v[rng.random(v.size) < 0.08] = 0.0  # dry months
    monthly = [{"y": int(y), "m": int(m), "v": float(x)} for y, m, x in zip(years, months, v)]
    got = js("S.spi(D, 3).map(r=>r.spi)", monthly)
    acc = np.convolve(v, np.ones(3), "valid")
    acc = np.concatenate([[np.nan, np.nan], acc])
    ref = np.full(v.size, np.nan)
    for m in range(1, 13):
        base = (months == m) & (years >= 1991) & (years <= 2020) & ~np.isnan(acc)
        b = acc[base]
        q = np.mean(b <= 0)
        pos = b[b > 0]
        A = np.log(pos.mean()) - np.mean(np.log(pos))
        a = (1 + math.sqrt(1 + 4 * A / 3)) / (4 * A)
        beta = pos.mean() / a
        sel = (months == m) & ~np.isnan(acc)
        H = q + (1 - q) * np.where(acc[sel] > 0, stats.gamma.cdf(acc[sel], a, scale=beta), 0.0)
        ref[sel] = stats.norm.ppf(np.clip(H, 1e-6, 1 - 1e-6))
    got = np.array([np.nan if g is None else g for g in got], dtype=float)
    ok = ~np.isnan(ref)
    assert np.array_equal(ok, ~np.isnan(got))
    assert np.max(np.abs(got[ok] - ref[ok])) < 1e-5


def test_gumbel_lmoments():
    x = stats.gumbel_r.rvs(loc=120, scale=35, size=60, random_state=7)
    r = js("S.gumbelLMoments(D,[2,5,20,100])", x.tolist())
    xs = np.sort(x)
    n = xs.size
    b0 = xs.mean()
    b1 = np.sum(np.arange(n) / (n - 1) * xs) / n
    l2 = 2 * b1 - b0
    alpha = l2 / math.log(2)
    xi = b0 - np.euler_gamma * alpha
    for lev in r["levels"]:
        close(lev["value"], stats.gumbel_r.ppf(1 - 1 / lev["T"], loc=xi, scale=alpha), 1e-8, f"RL{lev['T']}")
    rp = js("S.returnPeriod(D.v, D.f)", {"v": float(stats.gumbel_r.ppf(0.95, loc=xi, scale=alpha)), "f": r})
    close(rp, 20.0, 1e-6, "return period inverse")


def test_gutenberg_richter_recovers_b():
    b_true, mmin = 1.0, 2.0
    m = mmin + rng.exponential(1 / (b_true * math.log(10)), 4000)
    m = np.round(m, 1)
    r = js("S.gutenbergRichter(D)", m.tolist())
    assert r["ok"]
    sel = m[m >= r["Mc"] - 1e-9]
    b_ref = math.log10(math.e) / (sel.mean() - (r["Mc"] - 0.05))
    close(r["b"], b_ref, 1e-9, "Aki-Utsu b")
    assert abs(r["b"] - b_true) < 4 * r["sb"] + 0.05


def test_usda_texture_reference_points():
    cases = {(92, 5, 3): "Sand", (82, 12, 6): "Loamy sand", (65, 25, 10): "Sandy loam", (40, 40, 20): "Loam",
             (20, 65, 15): "Silt loam", (5, 88, 7): "Silt", (60, 13, 27): "Sandy clay loam", (32, 34, 34): "Clay loam",
             (10, 56, 34): "Silty clay loam", (50, 5, 45): "Sandy clay", (5, 50, 45): "Silty clay", (20, 20, 60): "Clay"}
    got = js("D.map(([a,b,c])=>S.usdaTexture(a,b,c))", [list(k) for k in cases])
    assert got == list(cases.values()), got


def test_thermal_indices():
    # Stull (2011): T = 20 C, RH = 50 % -> Tw = 13.7 C (paper example)
    close(js("S.wetBulbStull(20,50)"), 13.7, 0.05, "Stull wet-bulb")
    # NWS heat-index table: 96 F, 65 % RH -> 121 F
    close(js("S.heatIndex(D,65)", (96 - 32) * 5 / 9) * 9 / 5 + 32, 121, 1.0, "NWS heat index")


def test_naqi_breakpoints():
    r = js("S.naqi({pm25:45, pm10:60, no2:30})")
    close(r["subs"]["pm25"], 51 + (100 - 51) * (45 - 31) / (60 - 31), 1e-9, "PM2.5 sub-index")
    assert r["dominant"] == "pm25" and r["category"] == "Satisfactory"
    assert js("S.naqi({pm25:300, pm10:80})")["category"] == "n/a"  # fewer than 3 pollutants


def test_geodesy():
    # 1 x 1 degree cell at the equator on a sphere: R^2 * dlon * (sin(lat2) - sin(lat1))
    R = 6371008.8
    ref = R**2 * math.radians(1) * (math.sin(math.radians(1)) - 0) / 1e6
    got = js("Gm.area({type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]})")
    close(got, ref, 1e-6 * ref, "spherical area")
    # polylabel of an L-shaped polygon must be inside it
    L_shape = [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]]]
    x, y = js("Gm.polylabel(D, 0.001)", L_shape)
    assert js("Gm.contains({type:'Polygon',coordinates:D.p}, D.x, D.y)", {"p": L_shape, "x": x, "y": y})
    pts = js("Gm.samplePoints({type:'Polygon',coordinates:D}, 100)", L_shape)
    assert 90 <= len(pts) <= 100


def test_every_district_interior_point_inside():
    """Interior point and lattice sample lie inside every one of the LGD districts."""
    code = (
        "const fs=require('fs');const t=require(" + json.dumps(str(ROOT / 'web/vendor/topojson-client.min.js')) + ");"
        "const Gm=require(" + json.dumps(str(JS / 'geo.js')) + ");"
        "const topo=JSON.parse(fs.readFileSync(" + json.dumps(str(ROOT / 'web/data/districts.topo.json')) + "));"
        "const F=t.feature(topo,topo.objects.districts).features;let bad=[];let area=0;"
        "for(const f of F){const [x,y]=Gm.interiorPoint(f.geometry);if(!Gm.contains(f.geometry,x,y))bad.push(f.properties.name);area+=Gm.area(f.geometry);}"
        "process.stdout.write(JSON.stringify({n:F.length,bad,area}));"
    )
    r = json.loads(subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True).stdout)
    assert r["n"] == 785 and not r["bad"], r["bad"][:10]
    # official geographical area of India 3,287,263 km2 (Survey of India, includes claimed territory)
    assert abs(r["area"] - 3_287_263) / 3_287_263 < 0.01, r["area"]


if __name__ == "__main__":
    import inspect
    import sys
    fns = [f for n, f in sorted(globals().items()) if n.startswith("test_") and inspect.isfunction(f)]
    fails = 0
    for f in fns:
        try:
            f()
            print(f"PASS {f.__name__}")
        except Exception as e:  # noqa: BLE001
            fails += 1
            print(f"FAIL {f.__name__}: {e}")
    sys.exit(1 if fails else 0)
