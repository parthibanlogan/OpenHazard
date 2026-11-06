/* OpenHazard India - dem.js
 * Leaflet GridLayer that decodes Terrarium-encoded elevation tiles in the browser and renders
 * hypsometric tint, slope (Horn 1981), hillshade or a bathtub inundation screen.
 * Terrarium decoding: h = (R * 256 + G + B / 256) - 32768  (metres).
 */
(function (root) {
  'use strict';
  root.OH = root.OH || {};
  const EARTH_CIRC = 40075016.686;

  const RAMPS = {
    tint: [[0, [38, 115, 77]], [0.15, [113, 166, 90]], [0.35, [214, 207, 125]], [0.55, [196, 150, 84]], [0.75, [148, 102, 70]], [0.9, [190, 180, 175]], [1, [250, 250, 250]]],
    slope: [[0, [255, 255, 204]], [0.11, [199, 233, 180]], [0.22, [127, 205, 187]], [0.33, [253, 174, 97]], [0.55, [244, 109, 67]], [0.78, [215, 48, 39]], [1, [120, 0, 40]]],
    depth: [[0, [198, 219, 239]], [0.3, [107, 174, 214]], [0.6, [33, 113, 181]], [1, [8, 48, 107]]],
  };
  function ramp(stops, t) {
    t = Math.min(1, Math.max(0, t));
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], f = (t - t0) / (t1 - t0 || 1);
        return [c0[0] + f * (c1[0] - c0[0]), c0[1] + f * (c1[1] - c0[1]), c0[2] + f * (c1[2] - c0[2])];
      }
    }
    return stops[stops.length - 1][1];
  }
  const cssRamp = (name) => 'linear-gradient(90deg,' + RAMPS[name].map(([t, c]) => `rgb(${c.join(',')}) ${t * 100}%`).join(',') + ')';

  const SHARED = new Map(); // decoded tiles shared by all DEM layers (~262 kB each)
  function createDemLayer(L, urlTemplate, opts) {
    const DemLayer = L.GridLayer.extend({
      options: { tileSize: 256, maxNativeZoom: 13, minZoom: 3, opacity: 0.75, mode: 'tint', zmin: 0, zmax: 3000, slopeMax: 45, waterLevel: 10, zFactor: 1.5, attribution: 'Elevation: Tilezen/Mapzen Terrain Tiles' },
      initialize(o) { L.setOptions(this, o); this._elev = SHARED; this._errors = 0; this._ok = 0; },
      setParams(p) { L.setOptions(this, p); this.redraw(); },
      createTile(coords, done) {
        const tile = document.createElement('canvas');
        tile.width = tile.height = 256;
        const key = `${coords.z}/${coords.x}/${coords.y}`;
        const draw = (elev) => { this._render(tile, elev, coords); done(null, tile); };
        if (this._elev.has(key)) { setTimeout(() => draw(this._elev.get(key)), 0); return tile; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const c = document.createElement('canvas'); c.width = c.height = 256;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, 256, 256).data, e = new Float32Array(65536);
            for (let i = 0; i < 65536; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
            if (this._elev.size > 96) this._elev.delete(this._elev.keys().next().value);
            this._elev.set(key, e); this._ok++;
            draw(e);
          } catch (err) { this._errors++; this.fire('demerror', { err }); done(err, tile); }
        };
        img.onerror = () => { this._errors++; this.fire('demerror', { err: new Error('tile load failed ' + key) }); done(new Error('tile'), tile); };
        img.src = L.Util.template(urlTemplate, { z: coords.z, x: coords.x, y: coords.y });
        return tile;
      },
      pixelSize(coords) { // metres per pixel at tile centre latitude (Web Mercator)
        const n = Math.PI - 2 * Math.PI * (coords.y + 0.5) / Math.pow(2, coords.z);
        const lat = Math.atan(Math.sinh(n));
        return EARTH_CIRC * Math.cos(lat) / (256 * Math.pow(2, coords.z));
      },
      _render(canvas, e, coords) {
        const o = this.options, ctx = canvas.getContext('2d'), img = ctx.createImageData(256, 256), px = img.data;
        const cs = this.pixelSize(coords), at = (x, y) => e[Math.min(255, Math.max(0, y)) * 256 + Math.min(255, Math.max(0, x))];
        const az = (360 - 315 + 90) * Math.PI / 180, zen = (90 - 45) * Math.PI / 180;
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
          const i = y * 256 + x, z = e[i]; let rgb, a = 255;
          if (o.mode === 'tint') {
            if (z <= 0 && z > -10) { rgb = [170, 200, 225]; a = 120; } else rgb = ramp(RAMPS.tint, (z - o.zmin) / (o.zmax - o.zmin || 1));
          } else {
            const a1 = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1), d = at(x - 1, y), f = at(x + 1, y), g = at(x - 1, y + 1), h = at(x, y + 1), k = at(x + 1, y + 1);
            const dzdx = ((c + 2 * f + k) - (a1 + 2 * d + g)) / (8 * cs), dzdy = ((g + 2 * h + k) - (a1 + 2 * b + c)) / (8 * cs);
            if (o.mode === 'slope') {
              const s = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
              rgb = ramp(RAMPS.slope, s / o.slopeMax); a = s < 0.5 ? 60 : 255;
            } else if (o.mode === 'shade') {
              const zf = o.zFactor, slope = Math.atan(zf * Math.hypot(dzdx, dzdy));
              let aspect = Math.atan2(dzdy, -dzdx); if (aspect < 0) aspect += 2 * Math.PI;
              const hs = Math.max(0, Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect));
              const v = 255 * hs; rgb = [v, v, v];
            } else { // flood
              const depth = o.waterLevel - z;
              if (depth >= 0 && z > -50) { rgb = ramp(RAMPS.depth, depth / Math.max(1, o.waterLevel - o.zmin)); a = 200; } else { rgb = [0, 0, 0]; a = 0; }
            }
          }
          px[i * 4] = rgb[0]; px[i * 4 + 1] = rgb[1]; px[i * 4 + 2] = rgb[2]; px[i * 4 + 3] = a;
        }
        ctx.putImageData(img, 0, 0);
      },
      /** Elevation (m) under a LatLng from the cached native tiles, or NaN. */
      elevationAt(latlng) {
        if (!this._map) return NaN;
        const z = Math.min(this._map.getZoom(), this.options.maxNativeZoom);
        const p = this._map.project(latlng, z), tx = Math.floor(p.x / 256), ty = Math.floor(p.y / 256);
        const e = this._elev.get(`${z}/${tx}/${ty}`); if (!e) return NaN;
        return e[Math.floor(p.y - ty * 256) * 256 + Math.floor(p.x - tx * 256)];
      },
      stats() { return { ok: this._ok, errors: this._errors }; },
    });
    return new DemLayer(opts || {});
  }

  root.OH.dem = { createDemLayer, RAMPS, ramp, cssRamp };
})(typeof self !== 'undefined' ? self : this);
