/* OpenHazard India - geo.js : geodesy and polygon utilities (browser + Node). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.OH = root.OH || {}; root.OH.geo = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const R = 6371008.8; // IUGG mean Earth radius, m
  const rad = Math.PI / 180;

  const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

  /** Spherical ring area (Chamberlain & Duquette 2007), m2, sign = orientation. */
  function ringArea(ring) {
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      s += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
    }
    return s * R * R / 2;
  }
  function area(geom) { // km2
    return polysOf(geom).reduce((t, p) => t + Math.abs(ringArea(p[0])) - p.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0) / 1e6;
  }
  function haversine(lat1, lon1, lat2, lon2) { // km
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a))) / 1000;
  }
  function perimeter(geom) { // km, outer + inner rings
    let p = 0; polysOf(geom).forEach((poly) => poly.forEach((r) => { for (let i = 0; i < r.length - 1; i++) p += haversine(r[i][1], r[i][0], r[i + 1][1], r[i + 1][0]); }));
    return p;
  }
  function bbox(geom) {
    let w = 180, s = 90, e = -180, n = -90;
    polysOf(geom).forEach((p) => p[0].forEach(([x, y]) => { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }));
    return [w, s, e, n];
  }
  function inRing(x, y, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function contains(geom, x, y) {
    return polysOf(geom).some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
  }

  // --- polylabel: pole of inaccessibility (Garcia-Castellanos & Lombardo 2007; Mapbox polylabel) ---
  function segDistSq(px, py, a, b) {
    let [x, y] = a, dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = px - x; dy = py - y; return dx * dx + dy * dy;
  }
  function pointToPolyDist(x, y, poly) {
    let inside = false, minSq = Infinity;
    for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      minSq = Math.min(minSq, segDistSq(x, y, a, b));
    }
    return (inside ? 1 : -1) * Math.sqrt(minSq);
  }
  function polylabel(poly, precision = 0.005) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    poly[0].forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    const w = maxX - minX, h = maxY - minY, size = Math.min(w, h);
    if (size === 0) return [minX, minY];
    const cell = (x, y, hh) => { const d = pointToPolyDist(x, y, poly); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 }; };
    const queue = [];
    for (let x = minX; x < maxX; x += size) for (let y = minY; y < maxY; y += size) queue.push(cell(x + size / 2, y + size / 2, size / 2));
    let best = cell(minX + w / 2, minY + h / 2, 0);
    let iter = 0;
    while (queue.length && iter++ < 20000) {
      queue.sort((a, b) => a.max - b.max);
      const c = queue.pop();
      if (c.d > best.d) best = c;
      if (c.max - best.d <= precision) continue;
      const hh = c.h / 2;
      queue.push(cell(c.x - hh, c.y - hh, hh), cell(c.x + hh, c.y - hh, hh), cell(c.x - hh, c.y + hh, hh), cell(c.x + hh, c.y + hh, hh));
    }
    return [best.x, best.y];
  }
  /** Interior representative point of the largest part of a (Multi)Polygon. */
  function interiorPoint(geom) {
    const polys = polysOf(geom);
    const largest = polys.reduce((a, b) => (Math.abs(ringArea(b[0])) > Math.abs(ringArea(a[0])) ? b : a));
    const [w, s, e, n] = bbox({ type: 'Polygon', coordinates: largest });
    return polylabel(largest, Math.max(e - w, n - s) / 200);
  }
  /** Deterministic stratified sample of up to `n` points inside the geometry (regular lattice). */
  function samplePoints(geom, n = 100) {
    const [w, s, e, nn] = bbox(geom);
    const a = area(geom), bboxArea = haversine(s, w, s, e) * haversine(s, w, nn, w) || 1;
    const fill = Math.min(1, Math.max(0.05, a / bboxArea));
    let k = Math.ceil(Math.sqrt(n / fill)), pts = [];
    for (let tries = 0; tries < 6; tries++) {
      pts = [];
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
        const x = w + (i + 0.5) * (e - w) / k, y = s + (j + 0.5) * (nn - s) / k;
        if (contains(geom, x, y)) pts.push([x, y]);
      }
      if (pts.length >= n) break;
      k = Math.ceil(k * 1.35);
    }
    if (pts.length > n) { const step = pts.length / n; pts = Array.from({ length: n }, (_, i) => pts[Math.floor(i * step)]); }
    return pts;
  }

  return { R, polysOf, ringArea, area, perimeter, haversine, bbox, inRing, contains, polylabel, interiorPoint, samplePoints };
});
