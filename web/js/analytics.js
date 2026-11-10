/* OpenHazard India - analytics.js
 * Pure, dependency-free statistical and geophysical routines. Works in the browser (window.OH.stats)
 * and in Node (module.exports) so the test-suite can verify every function against SciPy.
 * Every routine cites the method it implements.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.OH = root.OH || {}; root.OH.stats = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const finite = (a) => a.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = (a) => { const v = finite(a); return v.length ? sum(v) / v.length : NaN; };
  function quantile(a, q) { // type-7 (R default, numpy 'linear')
    const v = finite(a).sort((x, y) => x - y);
    if (!v.length) return NaN;
    const h = (v.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
    return v[lo] + (h - lo) * (v[hi] - v[lo]);
  }
  const median = (a) => quantile(a, 0.5);
  function std(a, ddof = 1) {
    const v = finite(a); if (v.length <= ddof) return NaN;
    const m = sum(v) / v.length;
    return Math.sqrt(sum(v.map((x) => (x - m) ** 2)) / (v.length - ddof));
  }

  // ---------- special functions ----------
  // erfc: Numerical Recipes (Chebyshev), fractional error < 1.2e-7
  function erfc(x) {
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  const normCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);

  // Inverse standard normal: Acklam (2003) rational approximation + one Halley refinement step
  function normInv(p) {
    if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pl = 0.02425; let q, r, x;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    else if (p <= 1 - pl) { q = p - 0.5; r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const e = normCdf(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
    return x - u / (1 + x * u / 2);
  }

  function lnGamma(z) { // Lanczos g=7, n=9
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lnGamma(1 - z);
    z -= 1; let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  // Regularised lower incomplete gamma P(a,x): series for x<a+1, Lentz continued fraction otherwise
  function gammaP(a, x) {
    if (x <= 0) return 0;
    const gln = lnGamma(a);
    if (x < a + 1) {
      let ap = a, s = 1 / a, del = s;
      for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; s += del; if (Math.abs(del) < Math.abs(s) * 1e-15) break; }
      return s * Math.exp(-x + a * Math.log(x) - gln);
    }
    let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
      const an = -i * (i - a); b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-15) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
  }

  // ---------- trend ----------
  /** Mann-Kendall test with tie correction (Kendall 1975) and Sen (1968) slope.
   *  t: time coordinate (e.g. year), x: values. Returns S, varS, Z (continuity corrected), p (two-sided),
   *  tau, slope (units per unit t), intercept, n. */
  function mannKendall(t, x) {
    const pts = []; for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i]) && Number.isFinite(t[i])) pts.push([t[i], x[i]]);
    const n = pts.length; if (n < 4) return { n, S: NaN, Z: NaN, p: NaN, tau: NaN, slope: NaN, intercept: NaN };
    let S = 0; const slopes = [];
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      S += Math.sign(pts[j][1] - pts[i][1]);
      if (pts[j][0] !== pts[i][0]) slopes.push((pts[j][1] - pts[i][1]) / (pts[j][0] - pts[i][0]));
    }
    const counts = new Map(); pts.forEach(([, v]) => counts.set(v, (counts.get(v) || 0) + 1));
    let tieTerm = 0; counts.forEach((c) => { if (c > 1) tieTerm += c * (c - 1) * (2 * c + 5); });
    const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
    const Z = S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
    const p = 2 * (1 - normCdf(Math.abs(Z)));
    const slope = median(slopes);
    const intercept = median(pts.map(([ti, v]) => v - slope * ti));
    return { n, S, varS, Z, p, tau: S / (n * (n - 1) / 2), slope, intercept };
  }

  // ---------- Standardised Precipitation Index (McKee et al. 1993) ----------
  /** Gamma fit by Thom (1958) maximum-likelihood approximation on strictly positive values. */
  function gammaFitThom(v) {
    const x = finite(v).filter((u) => u > 0); if (x.length < 3) return null;
    const m = mean(x), A = Math.log(m) - mean(x.map(Math.log));
    if (!(A > 0)) return null;
    const alpha = (1 + Math.sqrt(1 + 4 * A / 3)) / (4 * A);
    return { alpha, beta: m / alpha };
  }
  /** monthly: [{y, m, v}] chronologically ordered, contiguous. k: accumulation (months).
   *  Mixed distribution H = q + (1-q) G(x) for zeros (Thom 1966). Fitted per calendar month on the
   *  base period [y0, y1]. Gaps and missing/negative values invalidate every accumulation window
   *  that crosses them. Returns array of {y, m, sum, spi}. */
  function spi(monthly, k, y0 = 1991, y1 = 2020) {
    if (!Number.isInteger(k) || k < 1) throw new RangeError('SPI accumulation must be a positive integer number of months');
    const ordinal = (r) => {
      if (!Number.isInteger(r.y) || !Number.isInteger(r.m) || r.m < 1 || r.m > 12) throw new RangeError('SPI months require an integer year and month from 1 to 12');
      return r.y * 12 + r.m - 1;
    };
    const ordinals = monthly.map(ordinal);
    const acc = monthly.map((r, i) => {
      if (i < k - 1) return { y: r.y, m: r.m, sum: NaN };
      let s = 0;
      for (let j = i - k + 1; j <= i; j++) {
        if (j > i - k + 1 && ordinals[j] !== ordinals[j - 1] + 1) return { y: r.y, m: r.m, sum: NaN };
        const v = monthly[j].v;
        if (!Number.isFinite(v) || v < 0) return { y: r.y, m: r.m, sum: NaN };
        s += v;
      }
      return { y: r.y, m: r.m, sum: s };
    });
    const params = {};
    for (let m = 1; m <= 12; m++) {
      const base = acc.filter((r) => r.m === m && r.y >= y0 && r.y <= y1 && Number.isFinite(r.sum)).map((r) => r.sum);
      const zeros = base.filter((v) => v <= 0).length;
      params[m] = { q: base.length ? zeros / base.length : NaN, fit: gammaFitThom(base), n: base.length };
    }
    return acc.map((r) => {
      const P = params[r.m];
      if (!Number.isFinite(r.sum) || !P.fit || P.n < 20) return { ...r, spi: NaN };
      const G = r.sum > 0 ? gammaP(P.fit.alpha, r.sum / P.fit.beta) : 0;
      let H = P.q + (1 - P.q) * G;
      H = Math.min(Math.max(H, 1e-6), 1 - 1e-6); // bound to +-4.75 sigma
      return { ...r, spi: normInv(H) };
    });
  }
  function spiClass(s) { // McKee et al. (1993)
    if (!Number.isFinite(s)) return 'n/a';
    if (s <= -2) return 'Extremely dry'; if (s <= -1.5) return 'Severely dry'; if (s <= -1) return 'Moderately dry';
    if (s < 1) return 'Near normal'; if (s < 1.5) return 'Moderately wet'; if (s < 2) return 'Very wet'; return 'Extremely wet';
  }

  // ---------- daily climate -> monthly / annual ----------
  function toMonthly(dates, values, agg = 'sum', minFrac = 0.9) {
    const groups = new Map();
    dates.forEach((d, i) => { const key = d.slice(0, 7); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(values[i]); });
    const out = [];
    if (!groups.size) return out;
    const keys = [...groups.keys()].sort();
    const first = keys[0].split('-').map(Number), last = keys[keys.length - 1].split('-').map(Number);
    for (let month = first[0] * 12 + first[1] - 1, end = last[0] * 12 + last[1] - 1; month <= end; month++) {
      const y = Math.floor(month / 12), m = month % 12 + 1, key = `${y}-${String(m).padStart(2, '0')}`;
      const vals = groups.get(key) || [];
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const v = finite(vals);
      const ok = v.length > 0 && v.length >= minFrac * days;
      out.push({ y, m, v: ok ? (agg === 'sum' ? sum(v) : sum(v) / v.length) : NaN, n: v.length, days });
    }
    return out;
  }
  function climatology(monthly, y0 = 1991, y1 = 2020) { // WMO standard normal period
    const out = [];
    for (let m = 1; m <= 12; m++) {
      const v = monthly.filter((r) => r.m === m && r.y >= y0 && r.y <= y1).map((r) => r.v);
      out.push({ m, mean: mean(v), p10: quantile(v, 0.1), p90: quantile(v, 0.9), n: finite(v).length });
    }
    return out;
  }
  /** ETCCDI-style annual indices (Zhang et al. 2011) from daily series. Years with <90 % valid days are skipped. */
  function annualIndices(dates, tmax, tmin, tmean, pr) {
    const years = new Map();
    dates.forEach((d, i) => { const y = +d.slice(0, 4); if (!years.has(y)) years.set(y, []); years.get(y).push(i); });
    const out = [];
    years.forEach((idx, y) => {
      const ndays = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365;
      const ok = (arr) => finite(idx.map((i) => arr[i])).length >= 0.9 * ndays;
      if (![tmax, tmin, tmean, pr].every(ok)) return;
      const tx = idx.map((i) => tmax[i]), tn = idx.map((i) => tmin[i]), tm = idx.map((i) => tmean[i]), p = idx.map((i) => pr[i]);
      let cdd = 0, run = 0; p.forEach((v) => { if (Number.isFinite(v) && v < 1) { run++; cdd = Math.max(cdd, run); } else run = 0; });
      out.push({
        year: y, TXx: Math.max(...finite(tx)), TNn: Math.min(...finite(tn)), Tmean: mean(tm),
        PRCPTOT: sum(finite(p).filter((v) => v >= 1)), Rx1day: Math.max(...finite(p)),
        R20mm: finite(p).filter((v) => v >= 20).length, CDD: cdd,
        TX40: finite(tx).filter((v) => v >= 40).length,
      });
    });
    return out.sort((a, b) => a.year - b.year);
  }

  // ---------- extremes ----------
  /** Gumbel (EV1) fit by L-moments (Hosking 1990) and return levels for periods T (years). */
  function gumbelLMoments(x, T = [2, 5, 10, 20, 50]) {
    const v = finite(x).sort((a, b) => a - b), n = v.length;
    if (n < 10) return null;
    const b0 = mean(v);
    let b1 = 0; for (let i = 0; i < n; i++) b1 += (i / (n - 1)) * v[i]; b1 /= n;
    const l1 = b0, l2 = 2 * b1 - b0;
    const alpha = l2 / Math.LN2, xi = l1 - 0.5772156649015329 * alpha;
    const levels = T.map((t) => ({ T: t, value: xi - alpha * Math.log(-Math.log(1 - 1 / t)) }));
    return { n, xi, alpha, l1, l2, levels };
  }
  function returnPeriod(value, fit) {
    if (!fit || !Number.isFinite(value)) return NaN;
    const F = Math.exp(-Math.exp(-(value - fit.xi) / fit.alpha));
    return F >= 1 ? Infinity : 1 / (1 - F);
  }

  /** Gutenberg-Richter: Mc by maximum curvature + 0.2 (Woessner & Wiemer 2005), b by Aki (1965)/Utsu
   *  MLE with bin correction, sigma_b by Shi & Bolt (1982). */
  function gutenbergRichter(mags, dM = 0.1) {
    const m = finite(mags).map((v) => Math.round(v / dM) * dM);
    if (m.length < 30) return { n: m.length, ok: false };
    const hist = new Map(); m.forEach((v) => { const k = v.toFixed(1); hist.set(k, (hist.get(k) || 0) + 1); });
    let maxc = null, maxn = -1; hist.forEach((c, k) => { if (c > maxn) { maxn = c; maxc = +k; } });
    const Mc = +(maxc + 0.2).toFixed(1);
    const sel = m.filter((v) => v >= Mc - 1e-9), n = sel.length;
    if (n < 30) return { n, Mc, ok: false };
    const mm = mean(sel);
    const b = Math.LOG10E / (mm - (Mc - dM / 2));
    const sb = 2.3 * b * b * Math.sqrt(sum(sel.map((v) => (v - mm) ** 2)) / (n * (n - 1)));
    const a = Math.log10(n) + b * Mc;
    const fmd = [...hist.entries()].map(([k, c]) => ({ M: +k, n: c })).sort((x, y) => x.M - y.M);
    let cum = 0; for (let i = fmd.length - 1; i >= 0; i--) { cum += fmd[i].n; fmd[i].N = cum; }
    return { ok: true, n, Mc, b, sb, a, fmd };
  }

  // ---------- soils ----------
  /** USDA soil texture class from sand/silt/clay percentages (Soil Survey Staff, USDA texture triangle). */
  function usdaTexture(sand, silt, clay) {
    const t = sand + silt + clay; if (!(t > 0)) return 'n/a';
    sand *= 100 / t; silt *= 100 / t; clay *= 100 / t;
    if (silt + 1.5 * clay < 15) return 'Sand';
    if (silt + 1.5 * clay >= 15 && silt + 2 * clay < 30) return 'Loamy sand';
    if ((clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) || (clay < 7 && silt < 50 && silt + 2 * clay >= 30)) return 'Sandy loam';
    if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return 'Loam';
    if ((silt >= 50 && clay >= 12 && clay < 27) || (silt >= 50 && silt < 80 && clay < 12)) return 'Silt loam';
    if (silt >= 80 && clay < 12) return 'Silt';
    if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return 'Sandy clay loam';
    if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return 'Clay loam';
    if (clay >= 27 && clay < 40 && sand <= 20) return 'Silty clay loam';
    if (clay >= 35 && sand > 45) return 'Sandy clay';
    if (clay >= 40 && silt >= 40) return 'Silty clay';
    if (clay >= 40 && sand <= 45 && silt < 40) return 'Clay';
    return 'Unclassified';
  }

  // ---------- terrain ----------
  function hypsometry(elev) {
    const v = finite(elev).sort((a, b) => a - b); if (v.length < 5) return null;
    const min = v[0], max = v[v.length - 1], m = mean(v);
    return {
      n: v.length, min, max, mean: m, median: quantile(v, 0.5), sd: std(v), p05: quantile(v, 0.05), p95: quantile(v, 0.95),
      relief: max - min, HI: max > min ? (m - min) / (max - min) : NaN, // Strahler (1952), elevation-relief ratio (Pike & Wilson 1971)
      curve: v.map((z, i) => ({ a: 1 - i / (v.length - 1), h: max > min ? (z - min) / (max - min) : 0 })),
    };
  }

  // ---------- thermal stress ----------
  /** Wet-bulb temperature (deg C) from T (deg C) and RH (%) at ~1013 hPa: Stull (2011), valid RH 5-99 %, T -20..50. */
  function wetBulbStull(T, RH) {
    if (!Number.isFinite(T) || !Number.isFinite(RH)) return NaN;
    return T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) + Math.atan(T + RH) - Math.atan(RH - 1.676331) +
      0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) - 4.686035;
  }
  /** NOAA/NWS heat index (Rothfusz 1990 with Steadman pre-screen and NWS adjustments), deg C in/out. */
  function heatIndex(Tc, RH) {
    if (!Number.isFinite(Tc) || !Number.isFinite(RH)) return NaN;
    const T = Tc * 9 / 5 + 32;
    let HI = 0.5 * (T + 61 + (T - 68) * 1.2 + RH * 0.094);
    if ((HI + T) / 2 >= 80) {
      HI = -42.379 + 2.04901523 * T + 10.14333127 * RH - 0.22475541 * T * RH - 6.83783e-3 * T * T - 5.481717e-2 * RH * RH +
        1.22874e-3 * T * T * RH + 8.5282e-4 * T * RH * RH - 1.99e-6 * T * T * RH * RH;
      if (RH < 13 && T >= 80 && T <= 112) HI -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
      else if (RH > 85 && T >= 80 && T <= 87) HI += ((RH - 85) / 10) * ((87 - T) / 5);
    }
    return (HI - 32) * 5 / 9;
  }

  // ---------- air quality: CPCB National AQI (2014) ----------
  const NAQI_BANDS = [[0, 50, 'Good'], [51, 100, 'Satisfactory'], [101, 200, 'Moderate'], [201, 300, 'Poor'], [301, 400, 'Very poor'], [401, 500, 'Severe']];
  const NAQI_BP = { // concentration breakpoints for each band (CPCB 2014), ug/m3 except CO mg/m3
    pm10: [[0, 50], [51, 100], [101, 250], [251, 350], [351, 430], [431, 1000]],
    pm25: [[0, 30], [31, 60], [61, 90], [91, 120], [121, 250], [251, 500]],
    no2: [[0, 40], [41, 80], [81, 180], [181, 280], [281, 400], [401, 1000]],
    o3: [[0, 50], [51, 100], [101, 168], [169, 208], [209, 748], [749, 1500]],
    co: [[0, 1.0], [1.1, 2.0], [2.1, 10], [10.1, 17], [17.1, 34], [34.1, 50]],
    so2: [[0, 40], [41, 80], [81, 380], [381, 800], [801, 1600], [1601, 2620]],
  };
  function naqiSub(pollutant, c) {
    const bp = NAQI_BP[pollutant]; if (!bp || !Number.isFinite(c) || c < 0) return NaN;
    for (let i = 0; i < bp.length; i++) {
      const [lo, hi] = bp[i], [ilo, ihi] = NAQI_BANDS[i];
      const nextLo = i + 1 < bp.length ? bp[i + 1][0] : Infinity;
      if (c <= hi || c < nextLo) return ilo + (ihi - ilo) * (Math.min(c, hi) - lo) / (hi - lo);
    }
    return 500;
  }
  function naqiCategory(v) { if (!Number.isFinite(v)) return 'n/a'; for (const [lo, hi, n] of NAQI_BANDS) if (v <= hi + 0.999) return n; return 'Severe'; }
  /** conc: {pm25, pm10 (24-h means), no2, so2 (24-h means), o3, co (max 8-h running means)}.
   *  CPCB requires >=3 pollutants including PM2.5 or PM10. */
  function naqi(conc) {
    const subs = {}; Object.keys(NAQI_BP).forEach((k) => { const s = naqiSub(k, conc[k]); if (Number.isFinite(s)) subs[k] = s; });
    const keys = Object.keys(subs);
    if (keys.length < 3 || !(('pm25' in subs) || ('pm10' in subs))) return { value: NaN, category: 'n/a', subs };
    const dom = keys.reduce((a, b) => (subs[a] >= subs[b] ? a : b));
    return { value: Math.round(subs[dom]), category: naqiCategory(subs[dom]), dominant: dom, subs };
  }
  function maxRunningMean(a, w) {
    let best = NaN;
    for (let i = 0; i + w <= a.length; i++) { const s = finite(a.slice(i, i + w)); if (s.length >= 0.75 * w) { const m = sum(s) / s.length; if (!(m <= best)) best = m; } }
    return best;
  }

  // ---------- IMD rainfall intensity (24-h accumulation, mm) ----------
  function imdRainClass(mm) {
    if (!Number.isFinite(mm)) return 'n/a';
    if (mm < 0.1) return 'No rain'; if (mm < 2.5) return 'Very light'; if (mm <= 15.5) return 'Light';
    if (mm <= 64.4) return 'Moderate'; if (mm <= 115.5) return 'Heavy'; if (mm <= 204.4) return 'Very heavy'; return 'Extremely heavy';
  }

  return {
    finite, sum, mean, median, quantile, std, erfc, normCdf, normInv, lnGamma, gammaP,
    mannKendall, gammaFitThom, spi, spiClass, toMonthly, climatology, annualIndices,
    gumbelLMoments, returnPeriod, gutenbergRichter, usdaTexture, hypsometry,
    wetBulbStull, heatIndex, naqi, naqiSub, naqiCategory, maxRunningMean, imdRainClass, NAQI_BP,
  };
});
