/* OpenHazard India - app.js : map, selection, layers, dossier, state pulse. */
(function () {
  'use strict';
  const { config: C, stats: ST, geo: G, api: A, dem: DEM } = window.OH;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const isMobile = () => matchMedia('(max-width: 860px)').matches;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
  const isoDate = (d) => d.toISOString().slice(0, 10);
  const daysAgo = (n) => isoDate(new Date(Date.now() - n * 864e5));

  const S = {
    map: null, D: [], byLgd: new Map(), byState: new Map(), stateFeat: new Map(), selState: '', selDist: null,
    point: null, pointUser: false, base: 'light', baseLayer: null, overlays: new Map(), overlayState: {},
    charts: {}, tab: 'overview', token: 0, results: [], log: [], pulse: new Map(), pulseMetric: 'tw_max',
    layers: {}, swipeX: null, seismicLayer: null, labels: null,
  };

  // ------------------------------------------------------------------ utilities
  function toast(msg, ms = 3200) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }
  function record(section, metric, value, unit, source) {
    S.results.push({ section, metric, value: typeof value === 'number' ? +value.toPrecision(6) : value, unit, source });
  }
  async function get(url, opts, label) {
    const r = await A.fetchJSON(url, opts);
    S.log.push({ label, url, fetched_utc: new Date(r.fetched).toISOString(), cached: r.cached, stale: !!r.stale });
    if (r.stale) toast(`${label}: showing cached data from ${new Date(r.fetched).toLocaleString()} (network unavailable)`);
    return r.data;
  }
  function chart(id, cfg) {
    if (S.charts[id]) { S.charts[id].destroy(); delete S.charts[id]; }
    const el = document.getElementById(id); if (!el) return null;
    const ink = css('--ink'), rule = css('--rule');
    Chart.defaults.color = ink; Chart.defaults.borderColor = rule; Chart.defaults.font.family = css('--ui');
    cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false } }, cfg.options || {});
    S.charts[id] = new Chart(el, cfg);
    return S.charts[id];
  }
  const skeleton = (n = 3) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
  const errBox = (what, err, retryId) => `<p class="warn">${esc(what)} could not be loaded: ${esc(err && err.message ? err.message : err)}.</p>
    <p class="note">The service may be busy or blocked on this network. Cached results are used automatically when available.</p>
    ${retryId ? `<button class="btn ghost" data-retry="${retryId}">Try again</button>` : ''}`;
  const kv = (items) => `<div class="kv">${items.map(([k, v, u, c]) => `<div><div class="k">${esc(k)}</div><div class="v">${v}${u ? ` <small>${esc(u)}</small>` : ''}</div>${c ? `<div class="c">${c}</div>` : ''}</div>`).join('')}</div>`;
  const pill = (t, kind) => `<span class="pill ${kind || ''}">${esc(t)}</span>`;
  const sig = (p) => (p < 0.01 ? 'p < 0.01' : p < 0.05 ? 'p < 0.05' : `p = ${fmt(p, 2)}`);

  // ------------------------------------------------------------------ theme
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
    Object.values(S.charts).forEach((c) => c.update());
  }
  $('#btnTheme').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark'; try { localStorage.setItem('oh-theme', next); } catch (_) {}
    applyTheme(next); restyle(); renderTab(S.tab, true);
  });
  try { const t = localStorage.getItem('oh-theme'); if (t) applyTheme(t); } catch (_) {}

  // ------------------------------------------------------------------ map
  function initMap() {
    const map = L.map('map', { zoomControl: false, minZoom: 3, maxZoom: 18, worldCopyJump: false, preferCanvas: false, zoomSnap: 0.25 });
    S.map = map;
    [['overlays', 300], ['districts', 420], ['masks', 425], ['states', 430], ['selected', 440], ['points', 620]].forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
    map.getPane('masks').style.pointerEvents = 'none';
    map.getPane('states').style.pointerEvents = 'none';
    map.getPane('selected').style.pointerEvents = 'none';
    map.fitBounds([[6.5, 68], [37.1, 97.4]]);
    L.control.zoom({ position: isMobile() ? 'topright' : 'topleft' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    setBase(S.base);
    map.on('click', (e) => onMapClick(e.latlng, null));
    map.on('mousemove', onMouseMove);
    map.on('move zoom resize', () => { if (S.swipeX != null) clipSwipe(); });
  }
  function setBase(key) {
    const def = C.BASEMAPS[key] || C.BASEMAPS.light;
    if (S.baseLayer) S.map.removeLayer(S.baseLayer);
    S.baseLayer = L.tileLayer(def.url, def.opts).addTo(S.map);
    S.base = key;
    $$('#basemapSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.key === key)));
    writeHash();
  }

  // ------------------------------------------------------------------ boundaries
  async function loadBoundaries() {
    const [dt, st] = await Promise.all([
      fetch('data/districts.topo.json').then((r) => { if (!r.ok) throw new Error('districts ' + r.status); return r.json(); }),
      fetch('data/states.topo.json').then((r) => { if (!r.ok) throw new Error('states ' + r.status); return r.json(); }),
    ]);
    S.D = topojson.feature(dt, dt.objects.districts).features;
    S.D.forEach((f) => {
      const p = f.properties; f._lgd = String(p.lgd); f._state = p.state; f._name = p.name;
      const [w, s, e, n] = G.bbox(f.geometry); f._bbox = [w, s, e, n]; f._bounds = L.latLngBounds([s, w], [n, e]);
      S.byLgd.set(f._lgd, f);
      if (!S.byState.has(f._state)) S.byState.set(f._state, []);
      S.byState.get(f._state).push(f);
    });
    S.byState.forEach((arr) => arr.sort((a, b) => a._name.localeCompare(b._name)));
    topojson.feature(st, st.objects.states).features.forEach((f) => S.stateFeat.set(f.properties.name, f));

    const renderer = L.canvas({ padding: 0.4, tolerance: 4 });
    S.layers.districts = L.geoJSON({ type: 'FeatureCollection', features: S.D }, {
      pane: 'districts', renderer, style: styleDistrict,
      onEachFeature: (f, l) => { f._layer = l; l.on('click', (e) => { L.DomEvent.stopPropagation(e); onMapClick(e.latlng, f); }); },
    }).addTo(S.map);
    S.layers.states = L.geoJSON(topojson.mesh(st, st.objects.states), { pane: 'states', interactive: false, style: () => ({ color: css('--ink'), weight: 1.3, opacity: 0.75, fill: false }) }).addTo(S.map);

    const sel = $('#stateSelect');
    [...S.byState.keys()].sort().forEach((s) => sel.insertAdjacentHTML('beforeend', `<option value="${esc(s)}">${esc(s)} (${S.byState.get(s).length})</option>`));
    $('#placeList').innerHTML = S.D.map((f) => `<option value="${esc(f._name)}, ${esc(f._state)}"></option>`).join('');
    fetch('data/MANIFEST.json').then((r) => r.json()).then((m) => {
      $('#buildMeta').textContent = `${m.districts} districts, ${m.states_uts} States/UTs. LGD boundaries, source commit ${m.source_commit.slice(0, 7)}, built ${m.built_utc.slice(0, 10)}. App v${C.VERSION}.`;
    }).catch(() => {});
  }
  function styleDistrict(f) {
    const inState = S.selState && f._state === S.selState, sel = S.selDist === f, show = $('#chkDistricts').checked;
    const pv = S.selState && S.pulse.get(S.selState);
    let fill = false, fillColor = css('--blue'), fillOpacity = 0;
    if (pv && inState && pv.values[f._lgd] != null && Number.isFinite(pv.values[f._lgd][S.pulseMetric])) {
      fill = true; fillColor = pulseColor(S.pulseMetric, pv.values[f._lgd][S.pulseMetric]); fillOpacity = sel ? 0.25 : 0.62;
    } else if (!S.selState) { fill = true; fillOpacity = 0.0; }
    return {
      color: inState ? css('--ink') : css('--muted'), weight: sel ? 0 : inState ? 0.9 : 0.4,
      opacity: show ? (inState ? 0.85 : S.selState ? 0.35 : 0.55) : 0, fill: true, fillColor, fillOpacity: fill ? fillOpacity : 0,
    };
  }
  function restyle() {
    if (!S.layers.districts) return;
    S.layers.districts.setStyle(styleDistrict);
    if (S.layers.states) S.layers.states.setStyle({ color: css('--ink'), opacity: $('#chkStates').checked ? 0.75 : 0 });
    drawSelection();
  }
  function drawSelection() {
    ['selHalo', 'selLine', 'mask', 'pointMarker'].forEach((k) => { if (S.layers[k]) { S.map.removeLayer(S.layers[k]); S.layers[k] = null; } });
    const geom = S.selDist ? S.selDist.geometry : S.selState && S.stateFeat.get(S.selState) ? S.stateFeat.get(S.selState).geometry : null;
    if (!geom) return;
    if ($('#chkMask').checked) {
      const holes = G.polysOf(geom).map((p) => p[0].map(([x, y]) => [y, x]));
      S.layers.mask = L.polygon([[[-85, -180], [85, -180], [85, 180], [-85, 180]], ...holes], { pane: 'masks', stroke: false, fillColor: css('--paper'), fillOpacity: 0.58, interactive: false }).addTo(S.map);
    }
    if (S.selDist) {
      S.layers.selHalo = L.geoJSON(geom, { pane: 'selected', interactive: false, style: { color: css('--paper'), weight: 7, opacity: 0.85, fill: false } }).addTo(S.map);
      S.layers.selLine = L.geoJSON(geom, { pane: 'selected', interactive: false, style: { color: css('--sienna'), weight: 2.6, opacity: 1, fill: false } }).addTo(S.map);
      if (S.point) {
        S.layers.pointMarker = L.circleMarker(S.point, { pane: 'points', radius: 6, color: css('--paper'), weight: 2, fillColor: css('--sienna'), fillOpacity: 1 })
          .bindTooltip(`Analysis point ${S.pointUser ? '(your choice)' : '(interior point)'}<br>${fmt(S.point[0], 4)} N, ${fmt(S.point[1], 4)} E`).addTo(S.map);
      }
    }
  }
  function updateLabels() {
    if (S.labels) { S.map.removeLayer(S.labels); S.labels = null; }
    if (!$('#chkLabels').checked) return;
    const list = S.selState ? S.byState.get(S.selState) : S.D;
    S.labels = L.layerGroup(list.map((f) => { const [x, y] = ip(f); return L.tooltip({ permanent: true, direction: 'center', className: 'dlabel', interactive: false }).setLatLng([y, x]).setContent(esc(f._name)); })).addTo(S.map);
  }
  const ip = (f) => (f._ip || (f._ip = G.interiorPoint(f.geometry)));

  function fit(bounds) {
    const pad = isMobile() ? { paddingTopLeft: [16, 64], paddingBottomRight: [16, Math.round(window.innerHeight * 0.48)] } : { padding: [28, 28] };
    S.map.flyToBounds(bounds, Object.assign({ duration: 0.6, maxZoom: 12 }, pad));
  }

  // ------------------------------------------------------------------ selection
  function populateDistricts() {
    const ds = $('#districtSelect');
    if (!S.selState) { ds.innerHTML = '<option value="">Choose a State first</option>'; ds.disabled = true; return; }
    ds.disabled = false;
    ds.innerHTML = `<option value="">All ${S.byState.get(S.selState).length} districts</option>` + S.byState.get(S.selState).map((f) => `<option value="${f._lgd}">${esc(f._name)}</option>`).join('');
    ds.value = S.selDist ? S.selDist._lgd : '';
  }
  function selectIndia() {
    S.selState = ''; S.selDist = null; S.point = null; $('#stateSelect').value = '';
    populateDistricts(); restyle(); updateLabels(); $('#cartouche').hidden = true;
    S.map.flyToBounds([[6.5, 68], [37.1, 97.4]], { duration: 0.6 });
    buildDossier(); writeHash();
  }
  function selectState(name, { fitView = true } = {}) {
    if (!S.byState.has(name)) return selectIndia();
    S.selState = name; S.selDist = null; S.point = null; $('#stateSelect').value = name;
    populateDistricts(); restyle(); updateLabels(); $('#cartouche').hidden = true;
    if (fitView) fit(L.latLngBounds(S.byState.get(name).map((f) => f._bounds)));
    buildDossier(); writeHash();
  }
  function selectDistrict(f, { point = null, fitView = true, tab = null } = {}) {
    if (!f) return;
    const changed = S.selDist !== f;
    S.selState = f._state; S.selDist = f; $('#stateSelect').value = f._state;
    if (point) { S.point = point; S.pointUser = true; } else if (changed || !S.point) { const [x, y] = ip(f); S.point = [y, x]; S.pointUser = false; }
    populateDistricts(); restyle(); updateLabels(); cartouche();
    if (fitView) fit(f._bounds);
    if (isMobile()) { $('#controls').classList.remove('open'); setSheet('half'); }
    buildDossier(tab); writeHash();
  }
  function setPoint(latlng) {
    S.point = [latlng.lat, latlng.lng]; S.pointUser = true; S.results = []; drawSelection(); cartouche(); buildDossier(S.tab); writeHash();
  }
  function cartouche() {
    const f = S.selDist, el = $('#cartouche'); if (!f) { el.hidden = true; return; }
    el.innerHTML = `<div class="t">${esc(f._name)}</div><div class="s">${esc(f._state)}</div>
      <dl><dt>LGD code</dt><dd>${esc(f._lgd)}</dd><dt>Census 2011</dt><dd>${esc(f.properties.census || '–')}</dd>
      <dt>Area</dt><dd>${fmt(G.area(f.geometry), 0)} km²</dd><dt>Analysis point</dt><dd>${fmt(S.point[0], 3)} N, ${fmt(S.point[1], 3)} E</dd></dl>`;
    el.hidden = false;
  }
  function findDistrictAt(lat, lon) {
    return S.D.find((f) => lon >= f._bbox[0] && lon <= f._bbox[2] && lat >= f._bbox[1] && lat <= f._bbox[3] && G.contains(f.geometry, lon, lat)) || null;
  }

  // ------------------------------------------------------------------ map click: select or inspect
  async function onMapClick(latlng, f) {
    f = f || findDistrictAt(latlng.lat, latlng.lng);
    if (f && f !== S.selDist) { selectDistrict(f); return; }
    const pop = L.popup({ maxWidth: 300 }).setLatLng(latlng).setContent('<div class="popup">Reading this location…</div>').openOn(S.map);
    const dem = [...S.overlays.values()].find((o) => o.def.kind === 'dem');
    const demZ = dem ? dem.layer.elevationAt(latlng) : NaN;
    let elev = NaN, lc = null;
    try { const d = await get(`${C.API.elevation}?latitude=${latlng.lat.toFixed(5)}&longitude=${latlng.lng.toFixed(5)}`, { ttl: 864e5 * 30 }, 'Elevation (point)'); elev = d.elevation && d.elevation[0]; } catch (_) {}
    const wc = [...S.overlays.values()].find((o) => o.def.featureInfo);
    if (wc) lc = await worldCoverAt(wc.def, latlng);
    const rows = [['Coordinates', `${fmt(latlng.lat, 5)} N, ${fmt(latlng.lng, 5)} E`], ['District', f ? `${esc(f._name)}, ${esc(f._state)}` : 'Outside Indian districts'],
      ['Elevation (Copernicus GLO-90)', Number.isFinite(elev) ? `${fmt(elev, 0)} m` : 'unavailable']];
    if (Number.isFinite(demZ)) rows.push(['Elevation (Terrarium tile)', `${fmt(demZ, 0)} m`]);
    if (wc) rows.push([wc.def.label, lc || 'Lookup not supported by the service on this network']);
    pop.setContent(`<div class="popup"><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      ${f ? '<div class="row"><button class="btn" id="popAnalyse">Analyse this point</button></div>' : ''}</div>`);
    const b = document.getElementById('popAnalyse');
    if (b) b.addEventListener('click', () => { S.map.closePopup(); if (f !== S.selDist) selectDistrict(f, { point: [latlng.lat, latlng.lng], fitView: false }); else setPoint(latlng); });
  }
  async function worldCoverAt(def, ll) {
    const d = 0.0005, q = A.qs({ SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo', LAYERS: def.opts.layers, QUERY_LAYERS: def.opts.layers, CRS: 'EPSG:4326',
      BBOX: `${ll.lat - d},${ll.lng - d},${ll.lat + d},${ll.lng + d}`, WIDTH: 11, HEIGHT: 11, I: 5, J: 5, INFO_FORMAT: 'text/plain', STYLES: '' });
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
      const txt = await (await fetch(`${def.url}?${q}`, { signal: ctl.signal })).text(); clearTimeout(t);
      const m = txt.match(/(?:value_?\d*|gray_index|band_?\s*\d*|pixel(?:\s*value)?|map)\s*[=:]\s*'?(\d{2,3})\b/i); // only an explicitly labelled pixel value
      const hit = m ? C.WORLDCOVER_LEGEND.find(([v]) => v === +m[1]) : null;
      return hit ? `${hit[1]} (class ${hit[0]})` : null;
    } catch (_) { return null; }
  }
  function onMouseMove(e) {
    const dem = [...S.overlays.values()].find((o) => o.def.kind === 'dem');
    const r = $('#readout');
    if (!dem || isMobile()) { r.hidden = true; return; }
    const z = dem.layer.elevationAt(e.latlng);
    r.hidden = !Number.isFinite(z);
    if (Number.isFinite(z)) r.textContent = `${fmt(e.latlng.lat, 4)} N  ${fmt(e.latlng.lng, 4)} E   elevation ${fmt(z, 0)} m`;
  }

  // ------------------------------------------------------------------ overlays

  function makeLayer(def) {
    const st = S.overlayState[def.id] || (S.overlayState[def.id] = { opacity: def.kind === 'dem' ? 0.75 : 0.8 });
    const base = { pane: 'overlays', opacity: st.opacity };
    if (def.kind === 'tile') return L.tileLayer(def.url, Object.assign({}, def.opts, base, { maxZoom: 19 }));
    if (def.kind === 'wms') return L.tileLayer.wms(def.url, Object.assign({}, def.opts, base, { maxZoom: 19 }));
    if (def.kind === 'gibs') {
      st.cand = st.cand || 0;
      const time = def.fixedTime || st.date; // omitted TIME = latest available granule
      const opts = Object.assign({}, base, { layers: def.layers[st.cand], format: def.jpeg ? 'image/jpeg' : 'image/png', transparent: !def.jpeg, version: '1.1.1', maxZoom: 19, attribution: 'NASA EOSDIS GIBS' });
      if (time) opts.time = time;
      return L.tileLayer.wms(C.GIBS, opts);
    }
    if (def.kind === 'soil') {
      st.prop = st.prop || 'clay'; st.depth = st.depth || '0-5cm';
      const P = C.SOIL_PROPS[st.prop];
      return L.tileLayer.wms(`${C.ISRIC}${P.map}.map`, Object.assign({}, base, { layers: P.depth ? `${st.prop}_${st.depth}_mean` : 'MostProbable', format: 'image/png', transparent: true, version: '1.3.0', maxZoom: 19, attribution: 'ISRIC SoilGrids 2.0 (CC BY 4.0)' }));
    }
    if (def.kind === 'dem') {
      Object.assign(st, { zmin: st.zmin ?? 0, zmax: st.zmax ?? 2500, slopeMax: st.slopeMax ?? 45, waterLevel: st.waterLevel ?? 10, zFactor: st.zFactor ?? 1.5 });
      const l = DEM.createDemLayer(L, C.API.terrarium, { mode: def.mode, pane: 'overlays', opacity: st.opacity, zmin: st.zmin, zmax: st.zmax, slopeMax: st.slopeMax, waterLevel: st.waterLevel, zFactor: st.zFactor });
      l.on('demerror', () => overlayHealth(def.id));
      return l;
    }
    if (def.kind === 'vector') return L.layerGroup();
    return null;
  }
  async function fillVector(def, group) {
    try {
      if (def.id === 'quakes') {
        const d = await get(def.url, { ttl: 10 * 60e3 }, 'USGS earthquakes (30 days)');
        L.geoJSON(d, {
          pane: 'points',
          pointToLayer: (f, ll) => L.circleMarker(ll, { pane: 'points', radius: 2 + 1.6 * Math.max(0, f.properties.mag - 2), color: css('--paper'), weight: 1, fillColor: css('--alert'), fillOpacity: 0.85 }),
          onEachFeature: (f, l) => l.bindPopup(`<div class="popup"><h3>M ${fmt(f.properties.mag, 1)}</h3>${esc(f.properties.place)}<br>${new Date(f.properties.time).toUTCString()}<br>Depth ${fmt(f.geometry.coordinates[2], 0)} km<br><a href="${esc(f.properties.url)}" target="_blank" rel="noopener">USGS event page</a></div>`),
        }).addTo(group);
        setStatus(def.id, `${d.features.length} events worldwide in the feed`, false);
      } else if (def.id === 'eonet') {
        const d = await get(def.url, { ttl: 30 * 60e3 }, 'NASA EONET open events');
        d.events.forEach((ev) => {
          const g = ev.geometry[ev.geometry.length - 1]; if (!g) return;
          const ll = g.type === 'Point' ? [g.coordinates[1], g.coordinates[0]] : [g.coordinates[0][0][1], g.coordinates[0][0][0]];
          L.circleMarker(ll, { pane: 'points', radius: 7, color: css('--paper'), weight: 1.5, fillColor: css('--sienna'), fillOpacity: 0.9 })
            .bindPopup(`<div class="popup"><h3>${esc(ev.title)}</h3>${esc(ev.categories.map((c) => c.title).join(', '))}<br>Last update ${esc(g.date)}<br>${ev.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.id)}</a>`).join(' ')}</div>`).addTo(group);
        });
        setStatus(def.id, `${d.events.length} open events in the South Asia box`, false);
      }
    } catch (err) { setStatus(def.id, `Feed unavailable: ${err.message}`, true); }
  }
  function setStatus(id, msg, bad) {
    const el = $(`#st-${id}`); if (!el) return;
    el.textContent = msg || ''; el.style.color = bad ? css('--alert') : css('--muted');
  }
  function overlayHealth(id) {
    const o = S.overlays.get(id); if (!o) return;
    if (o.layer.stats) { const s = o.layer.stats(); o.ok = s.ok; o.err = s.errors; }
    const st = S.overlayState[id];
    if (o.def.kind === 'gibs' && o.err >= 4 && !o.ok && st.cand + 1 < o.def.layers.length && !o._switching) {
      o._switching = true; st.cand++; setTimeout(() => { rebuildOverlay(id); setStatus(id, `Using GIBS layer ${o.def.layers[st.cand]}`, false); }, 0); return;
    }
    if (o.err >= 6 && !o.ok) setStatus(id, `No tiles received after ${o.err} requests. The service may be down or blocked on this network.`, true);
    else if (o.err && o.ok) setStatus(id, `${o.err} tiles missing (outside coverage or zoom limit).`, false);
    else setStatus(id, '', false);
  }
  function toggleOverlay(def, on) {
    if (on && def.exclusive) C.OVERLAYS.filter((d) => d.exclusive === def.exclusive && d.id !== def.id && S.overlays.has(d.id)).forEach((d) => { $(`#ov-${d.id}`).checked = false; toggleOverlay(d, false); });
    if (on && def.kind === 'dem') C.OVERLAYS.filter((d) => d.kind === 'dem' && d.id !== def.id && S.overlays.has(d.id)).forEach((d) => { $(`#ov-${d.id}`).checked = false; toggleOverlay(d, false); });
    const item = $(`#oi-${def.id}`);
    if (on) {
      const layer = makeLayer(def), o = { def, layer, ok: 0, err: 0 };
      if (layer.on && def.kind !== 'vector') {
        layer.on('tileload', () => { o.ok++; if (o.ok === 1) overlayHealth(def.id); });
        layer.on('tileerror', () => { o.err++; overlayHealth(def.id); });
      }
      layer.addTo(S.map); S.overlays.set(def.id, o);
      if (def.kind === 'vector') fillVector(def, layer);
      item.classList.add('on');
    } else {
      const o = S.overlays.get(def.id); if (o) S.map.removeLayer(o.layer);
      S.overlays.delete(def.id); item.classList.remove('on'); setStatus(def.id, '');
    }
    updateGroupCounts(); renderLegend(); writeHash();
  }
  function rebuildOverlay(id) {
    const def = C.OVERLAYS.find((d) => d.id === id); if (!S.overlays.has(id)) return;
    const o = S.overlays.get(id); S.map.removeLayer(o.layer); S.overlays.delete(id); toggleOverlay(def, true);
  }
  function overlayControls(def) {
    const st = S.overlayState[def.id] || (S.overlayState[def.id] = { opacity: def.kind === 'dem' ? 0.75 : 0.8 });
    let extra = '';
    if (def.kind === 'soil') {
      extra += `<label>Property<select data-k="prop">${Object.entries(C.SOIL_PROPS).map(([k, p]) => `<option value="${k}">${esc(p.label)} (${esc(p.unit)})</option>`).join('')}</select></label>
        <label>Depth<select data-k="depth">${C.SOIL_DEPTHS.map((d) => `<option>${d}</option>`).join('')}</select></label>`;
    }
    if (def.kind === 'gibs' && def.daily) extra += `<label>Date (UTC, blank = latest)<input type="date" data-k="date" max="${isoDate(new Date())}" min="2002-07-04"></label>`;
    if (def.mode === 'tint') extra += `<label>Colour range (m)<span class="row"><input type="number" data-k="zmin" value="${st.zmin ?? 0}" style="width:45%"><input type="number" data-k="zmax" value="${st.zmax ?? 2500}" style="width:45%"></span></label><button class="btn ghost" data-act="fitdem" type="button">Stretch to selected district</button>`;
    if (def.mode === 'slope') extra += `<label>Colour scale maximum (degrees)<input type="number" data-k="slopeMax" value="${st.slopeMax ?? 45}" min="5" max="90"></label>`;
    if (def.mode === 'shade') extra += `<label>Vertical exaggeration<input type="range" data-k="zFactor" min="0.5" max="5" step="0.5" value="${st.zFactor ?? 1.5}"></label>`;
    if (def.mode === 'flood') extra += `<label>Water level, m above sea level: <b data-out="waterLevel">${st.waterLevel ?? 10}</b><input type="range" data-k="waterLevel" min="0" max="200" step="0.5" value="${st.waterLevel ?? 10}"></label><p>Shows every pixel at or below this level, connected to water or not. Vertical error of the DEM is several metres; use only for first screening.</p>`;
    return `<div class="more" id="more-${def.id}">
      <label>Opacity<input type="range" data-k="opacity" min="0.1" max="1" step="0.05" value="${st.opacity}"></label>${extra}
      <div class="meta-src" hidden><p><b>Source:</b> ${esc(def.source)}<br><b>Resolution:</b> ${esc(def.res)}<br><b>Licence:</b> ${esc(def.licence)}<br><b>Cite:</b> ${esc(def.cite)}</p></div></div>`;
  }
  function buildOverlayPanel() {
    const host = $('#overlayGroups');
    const groups = [...new Set(C.OVERLAYS.map((d) => d.group))];
    host.innerHTML = groups.map((g) => `<details class="ogroup" data-group="${esc(g)}" ${['Terrain', 'Land cover'].includes(g) ? 'open' : ''}>
      <summary><span>${esc(g)}</span><span class="count"></span></summary><div class="items">
      ${C.OVERLAYS.filter((d) => d.group === g).map((d) => `<div class="oitem" id="oi-${d.id}"><div class="head">
        <label><input type="checkbox" id="ov-${d.id}" data-id="${d.id}"><span>${esc(d.label)}</span></label>
        <button class="info" type="button" data-info="${d.id}" title="Source and licence" aria-label="Source and licence of ${esc(d.label)}">i</button></div>
        <div class="status" id="st-${d.id}"></div>${overlayControls(d)}</div>`).join('')}</div></details>`).join('');
    host.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.id) { toggleOverlay(C.OVERLAYS.find((d) => d.id === t.dataset.id), t.checked); return; }
      const item = t.closest('.oitem'); if (!item || !t.dataset.k) return;
      const id = item.id.slice(3), st = S.overlayState[id], o = S.overlays.get(id), k = t.dataset.k;
      const v = t.type === 'range' || t.type === 'number' ? +t.value : t.value;
      st[k] = v;
      if (k === 'opacity') { if (o && o.layer.setOpacity) o.layer.setOpacity(v); return; }
      if (o && o.def.kind === 'dem') { o.layer.setParams({ [k]: v }); renderLegend(); return; }
      rebuildOverlay(id);
    });
    host.addEventListener('input', (e) => {
      const t = e.target; if (t.type !== 'range') return;
      const item = t.closest('.oitem'); const id = item.id.slice(3), st = S.overlayState[id], o = S.overlays.get(id);
      st[t.dataset.k] = +t.value;
      const out = item.querySelector(`[data-out="${t.dataset.k}"]`); if (out) out.textContent = t.value;
      if (t.dataset.k === 'opacity' && o && o.layer.setOpacity) o.layer.setOpacity(+t.value);
      if (o && o.def.kind === 'dem' && t.dataset.k !== 'opacity') { clearTimeout(o._t); o._t = setTimeout(() => { o.layer.setParams({ [t.dataset.k]: +t.value }); renderLegend(); }, 120); }
    });
    host.addEventListener('click', (e) => {
      const info = e.target.closest('[data-info]');
      if (info) { const item = $(`#oi-${info.dataset.info}`); item.classList.add('on'); const m = item.querySelector('.meta-src'); m.hidden = !m.hidden; }
      if (e.target.dataset.act === 'fitdem') fitDemToDistrict();
    });
  }
  function updateGroupCounts() {
    $$('.ogroup').forEach((g) => { const n = C.OVERLAYS.filter((d) => d.group === g.dataset.group && S.overlays.has(d.id)).length; g.querySelector('.count').textContent = n ? `${n} on` : ''; });
  }
  function fitDemToDistrict() {
    const h = S.selDist && S.selDist._hyps;
    if (!h) { toast('Open the Terrain tab for a district first: the colour range is taken from its elevation sample.'); setTab('terrain'); return; }
    const st = S.overlayState.dem_tint || (S.overlayState.dem_tint = { opacity: 0.75 });
    st.zmin = Math.floor(h.p05 / 10) * 10; st.zmax = Math.ceil(h.p95 / 10) * 10;
    const box = $('#more-dem_tint'); box.querySelector('[data-k="zmin"]').value = st.zmin; box.querySelector('[data-k="zmax"]').value = st.zmax;
    if (!S.overlays.has('dem_tint')) { $('#ov-dem_tint').checked = true; toggleOverlay(C.OVERLAYS.find((d) => d.id === 'dem_tint'), true); }
    else S.overlays.get('dem_tint').layer.setParams({ zmin: st.zmin, zmax: st.zmax });
    renderLegend(); toast(`Elevation colours stretched to ${st.zmin}–${st.zmax} m (5th–95th percentile of the district sample).`);
  }

  // ------------------------------------------------------------------ legend
  function renderLegend() {
    const cards = [];
    S.overlays.forEach(({ def, layer }) => {
      const st = S.overlayState[def.id] || {};
      if (def.legend) cards.push(`<div class="card"><b>${esc(def.label)}</b>${def.legend.map(([, n, c]) => `<div class="sw"><i style="background:${c}"></i>${esc(n)}</div>`).join('')}</div>`);
      else if (def.legendGradient) cards.push(`<div class="card"><b>${esc(def.label)}</b><div class="bar" style="background:linear-gradient(90deg,${def.legendGradient.join(',')})"></div><div class="ends"><span>${esc(def.legendRange[0])}</span><span>${esc(def.legendRange[1])}</span></div></div>`);
      else if (def.kind === 'soil') {
        const P = C.SOIL_PROPS[st.prop], lyr = P.depth ? `${st.prop}_${st.depth}_mean` : 'MostProbable';
        const src = `${C.ISRIC}${P.map}.map&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetLegendGraphic&FORMAT=image/png&LAYER=${lyr}&SLD_VERSION=1.1.0`;
        cards.push(`<div class="card"><b>${esc(P.label)}${P.depth ? `, ${esc(st.depth)}` : ''}</b><img alt="Legend for ${esc(P.label)}" src="${esc(src)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'Legend image unavailable; units ${esc(P.unit)}'}))"></div>`);
      } else if (def.kind === 'dem') {
        const zn = Math.min(Math.round(S.map.getZoom()), layer.options.maxNativeZoom), lat = S.map.getCenter().lat;
        const px = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, zn));
        const pxTxt = Number.isFinite(px) ? `Analysis pixel about ${fmt(px, 0)} m at this zoom` : '';
        if (def.mode === 'tint') cards.push(`<div class="card"><b>Elevation</b><div class="bar" style="background:${DEM.cssRamp('tint')}"></div><div class="ends"><span>${st.zmin} m</span><span>${st.zmax} m</span></div><span class="ends">${pxTxt}</span></div>`);
        if (def.mode === 'slope') cards.push(`<div class="card"><b>Slope</b><div class="bar" style="background:${DEM.cssRamp('slope')}"></div><div class="ends"><span>0°</span><span>${st.slopeMax}°+</span></div><span class="ends">${pxTxt}; slope is underestimated on coarse pixels</span></div>`);
        if (def.mode === 'flood') cards.push(`<div class="card"><b>Below ${st.waterLevel} m a.s.l.</b><div class="bar" style="background:${DEM.cssRamp('depth')}"></div><div class="ends"><span>shallow</span><span>deep</span></div><span class="ends">Static screening; no connectivity or defences</span></div>`);
        if (def.mode === 'shade') cards.push(`<div class="card"><b>Hillshade</b>Light from the north-west at 45°, exaggeration ×${st.zFactor}</div>`);
      } else if (def.kind === 'gibs') cards.push(`<div class="card"><b>${esc(def.label)}</b>${def.fixedTime ? `Composite ${esc(def.fixedTime.slice(0, 4))}` : `Date: ${esc(st.date || 'latest available')}`}. Colour scale as in NASA Worldview.</div>`);
    });
    if (S.selState && S.pulse.get(S.selState) && S.tab === 'pulse') cards.push(pulseLegend());
    $('#legend').innerHTML = cards.join('');
  }

  // ------------------------------------------------------------------ swipe compare
  function clipSwipe() {
    const pane = S.map.getPane('overlays'), size = S.map.getSize();
    const nw = S.map.containerPointToLayerPoint([0, 0]), se = S.map.containerPointToLayerPoint(size), cx = S.map.containerPointToLayerPoint([S.swipeX, 0]).x;
    pane.style.clip = `rect(${nw.y}px, ${cx}px, ${se.y}px, ${nw.x}px)`;
    $('#swipeHandle').style.left = S.swipeX + 'px';
  }
  function setSwipe(on) {
    const wrap = $('.mapwrap'); let h = $('#swipeHandle');
    if (!on) { S.swipeX = null; S.map.getPane('overlays').style.clip = ''; if (h) h.remove(); return; }
    if (!h) { h = document.createElement('div'); h.id = 'swipeHandle'; h.className = 'swipe-handle'; h.setAttribute('role', 'slider'); h.setAttribute('aria-label', 'Swipe position'); h.tabIndex = 0; wrap.appendChild(h); }
    S.swipeX = S.map.getSize().x / 2; clipSwipe();
    const move = (x) => { S.swipeX = Math.max(0, Math.min(S.map.getSize().x, x)); clipSwipe(); };
    h.onpointerdown = (e) => { h.setPointerCapture(e.pointerId); S.map.dragging.disable(); };
    h.onpointermove = (e) => { if (h.hasPointerCapture(e.pointerId)) move(e.clientX - wrap.getBoundingClientRect().left); };
    h.onpointerup = (e) => { h.releasePointerCapture(e.pointerId); S.map.dragging.enable(); };
    h.onkeydown = (e) => { if (e.key === 'ArrowLeft') move(S.swipeX - 20); if (e.key === 'ArrowRight') move(S.swipeX + 20); };
  }

  // ------------------------------------------------------------------ dossier
  const DISTRICT_TABS = [['overview', 'Overview'], ['terrain', 'Terrain'], ['soil', 'Soil'], ['climate', 'Climate'], ['weather', 'Weather'], ['air', 'Air'], ['rivers', 'Rivers'], ['hazards', 'Earthquakes'], ['sources', 'Sources']];
  const STATE_TABS = [['overview', 'Overview'], ['pulse', 'Next 72 h'], ['sources', 'Sources']];
  const INDIA_TABS = [['overview', 'Overview'], ['sources', 'Sources']];
  function buildDossier(tab) {
    S.token++; S.results = []; Object.keys(S.charts).forEach((k) => { S.charts[k].destroy(); delete S.charts[k]; });
    const tabs = S.selDist ? DISTRICT_TABS : S.selState ? STATE_TABS : INDIA_TABS;
    $('#dossierTitle').textContent = S.selDist ? S.selDist._name : S.selState || 'India';
    $('#dossierSub').textContent = S.selDist ? `${S.selDist._state}. Analysis point ${fmt(S.point[0], 3)} N, ${fmt(S.point[1], 3)} E (${S.pointUser ? 'chosen on the map' : 'interior point; tap the map to move it'}).`
      : S.selState ? `${S.byState.get(S.selState).length} districts. Pick one from the list or the map.` : `${S.stateFeat.size} States and Union Territories, ${S.D.length} districts (LGD).`;
    $('#tabs').innerHTML = tabs.map(([k, n]) => `<button role="tab" id="tab-${k}" data-tab="${k}" aria-selected="false" aria-controls="tabpanels">${n}</button>`).join('');
    $('#tabpanels').innerHTML = '';
    const want = tab && tabs.some(([k]) => k === tab) ? tab : tabs.some(([k]) => k === S.tab) ? S.tab : 'overview';
    setTab(want);
  }
  function setTab(k) {
    S.tab = k;
    $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
    const b = $(`#tab-${k}`); if (b) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    renderTab(k); renderLegend(); writeHash();
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  $('#tabpanels').addEventListener('click', (e) => {
    const r = e.target.closest('[data-retry]'); if (r) renderTab(r.dataset.retry, true);
    const row = e.target.closest('tr[data-lgd]'); if (row) selectDistrict(S.byLgd.get(row.dataset.lgd));
    const x = e.target.closest('[data-export]'); if (x) exportData(x.dataset.export);
  });
  async function renderTab(k, force) {
    const host = $('#tabpanels'), token = S.token;
    host.innerHTML = `<div class="panel" id="panel-${k}" role="tabpanel" aria-labelledby="tab-${k}">${skeleton(4)}</div>`;
    const panel = $(`#panel-${k}`);
    const fn = S.selDist ? { overview: tabOverview, terrain: tabTerrain, soil: tabSoil, climate: tabClimate, weather: tabWeather, air: tabAir, rivers: tabRivers, hazards: tabHazards, sources: tabSources }[k]
      : S.selState ? { overview: tabStateOverview, pulse: tabPulse, sources: tabSources }[k] : { overview: tabIndiaOverview, sources: tabSources }[k];
    if (!fn) return;
    try { await fn(panel, () => token === S.token && document.body.contains(panel)); }
    catch (err) { if (token === S.token) panel.innerHTML = errBox('This section', err, k); console.error(err); }
  }
  const pt = () => ({ lat: S.point[0].toFixed(4), lon: S.point[1].toFixed(4) });

  // ---- India / State overviews
  async function tabIndiaOverview(panel) {
    const rows = [...S.byState.entries()].map(([s, arr]) => ({ s, n: arr.length, a: arr.reduce((t, f) => t + (f._area || (f._area = G.area(f.geometry))), 0) })).sort((a, b) => b.a - a.a);
    const total = rows.reduce((t, r) => t + r.a, 0);
    panel.innerHTML = `${kv([['States and UTs', rows.length], ['Districts', S.D.length], ['Mapped area', fmt(total / 1e6, 3), 'million km²', 'Sum of simplified LGD polygons']])}
      <h3>How to use</h3><p>Pick a State to zoom in and see the next-72-hour heat, rain and air-quality picture for all its districts. Pick a district for its terrain, soil, 45-year climate record, rivers and seismicity. Tap anywhere inside a selected district to move the analysis point, for example onto a river.</p>
      <h3>States and Union Territories by area</h3><table class="data"><thead><tr><th>State / UT</th><th class="n">Districts</th><th class="n">Area, km²</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-state="${esc(r.s)}" style="cursor:pointer"><td>${esc(r.s)}</td><td class="n">${r.n}</td><td class="n">${fmt(r.a, 0)}</td></tr>`).join('')}</tbody></table>`;
    panel.querySelectorAll('tr[data-state]').forEach((tr) => tr.addEventListener('click', () => selectState(tr.dataset.state)));
  }
  async function tabStateOverview(panel) {
    const arr = S.byState.get(S.selState).map((f) => ({ f, a: f._area || (f._area = G.area(f.geometry)) })).sort((x, y) => y.a - x.a);
    const total = arr.reduce((t, r) => t + r.a, 0);
    panel.innerHTML = `${kv([['Districts', arr.length], ['Area', fmt(total, 0), 'km²'], ['Largest', esc(arr[0].f._name), '', `${fmt(arr[0].a, 0)} km²`], ['Smallest', esc(arr[arr.length - 1].f._name), '', `${fmt(arr[arr.length - 1].a, 0)} km²`]])}
      <p class="note">Open <b>Next 72 h</b> to colour every district by forecast heat stress, rain or air quality and to rank them with your own weights.</p>
      <table class="data"><thead><tr><th>District</th><th class="n">LGD</th><th class="n">Area, km²</th></tr></thead><tbody>
      ${arr.map((r) => `<tr data-lgd="${r.f._lgd}"><td>${esc(r.f._name)}</td><td class="n">${r.f._lgd}</td><td class="n">${fmt(r.a, 0)}</td></tr>`).join('')}</tbody></table>`;
  }

  // ---- District overview
  async function tabOverview(panel, alive) {
    const f = S.selDist, a = G.area(f.geometry), p = G.perimeter(f.geometry), pp = 4 * Math.PI * a / (p * p);
    const [w, s, e, n] = f._bbox;
    record('Geometry', 'Area', a, 'km2', 'LGD polygon (simplified), spherical area');
    record('Geometry', 'Perimeter', p, 'km', 'LGD polygon (simplified)');
    record('Geometry', 'Polsby-Popper compactness', pp, '-', 'Polsby & Popper (1991)');
    panel.innerHTML = `${kv([['Area', fmt(a, 0), 'km²'], ['Perimeter', fmt(p, 0), 'km', 'Simplified boundary; true coastline is longer'],
      ['Compactness', fmt(pp, 2), '', 'Polsby–Popper, 1 = circle'], ['Extent', `${fmt(n - s, 2)}° × ${fmt(e - w, 2)}°`, '', 'latitude × longitude']])}
      <h3>Hazard snapshot</h3><div id="snap">${skeleton(3)}</div>
      <p class="note">Snapshot values come from the Weather and Air tabs at the analysis point. Each tab explains its method and limits.</p>`;
    const out = [];
    try {
      const w = await loadForecast(); if (!alive()) return;
      const nowIdx = hourIndex(w.hourly.time);
      const tw = w.hourly.temperature_2m.map((t, i) => ST.wetBulbStull(t, w.hourly.relative_humidity_2m[i]));
      const twMax = Math.max(...ST.finite(tw.slice(nowIdx, nowIdx + 72)));
      const rain24 = ST.sum(ST.finite(w.hourly.precipitation.slice(nowIdx, nowIdx + 24)));
      out.push(['Air temperature now', fmt(w.current.temperature_2m, 1), '°C', `Feels like ${fmt(w.current.apparent_temperature, 1)} °C`]);
      out.push(['Rain, next 24 h', fmt(rain24, 1), 'mm', pill(ST.imdRainClass(rain24), rain24 > 64.4 ? 'alert' : '') + ' IMD class']);
      out.push(['Max wet-bulb, 72 h', fmt(twMax, 1), '°C', twMax >= 31 ? pill('Above 31 °C', 'alert') : twMax >= 28 ? pill('High') : pill('Below 28 °C', 'okc')]);
    } catch (err) { out.push(['Weather', 'n/a', '', esc(err.message)]); }
    try {
      const aq = await loadAir(); if (!alive()) return;
      const r = naqiFrom(aq, hourIndex(aq.hourly.time));
      out.push(['Air quality (NAQI method)', Number.isFinite(r.value) ? r.value : 'n/a', '', `${pill(r.category, r.value > 200 ? 'alert' : '')} from CAMS model`]);
    } catch (err) { out.push(['Air quality', 'n/a', '', esc(err.message)]); }
    if (alive()) $('#snap').innerHTML = kv(out);
  }
  function hourIndex(times) {
    const key = istNow().toISOString().slice(0, 13);
    const i = times.findIndex((t) => t.slice(0, 13) === key);
    return i >= 0 ? i : 0;
  }

  // ---- Terrain
  async function tabTerrain(panel, alive) {
    const f = S.selDist;
    const pts = G.samplePoints(f.geometry, 100);
    const url = `${C.API.elevation}?latitude=${pts.map((p) => p[1].toFixed(4)).join(',')}&longitude=${pts.map((p) => p[0].toFixed(4)).join(',')}`;
    const d = await get(url, { ttl: 864e5 * 90 }, 'Elevation sample (Copernicus GLO-90)'); if (!alive()) return;
    const h = ST.hypsometry(d.elevation); f._hyps = h;
    const pz = await get(`${C.API.elevation}?latitude=${pt().lat}&longitude=${pt().lon}`, { ttl: 864e5 * 90 }, 'Elevation (analysis point)');
    if (!alive()) return;
    [['Minimum', h.min], ['Mean', h.mean], ['Median', h.median], ['Maximum', h.max], ['Standard deviation', h.sd], ['Relief', h.relief]].forEach(([k, v]) => record('Terrain', `Elevation ${k.toLowerCase()}`, v, 'm', 'Copernicus DEM GLO-90 via Open-Meteo, lattice sample'));
    record('Terrain', 'Hypsometric integral', h.HI, '-', 'Strahler (1952); Pike & Wilson (1971)');
    panel.innerHTML = `${kv([['Mean elevation', fmt(h.mean, 0), 'm'], ['Range', `${fmt(h.min, 0)}–${fmt(h.max, 0)}`, 'm'], ['Relief', fmt(h.relief, 0), 'm', `SD ${fmt(h.sd, 0)} m`],
      ['Hypsometric integral', fmt(h.HI, 2), '', 'Descriptive elevation–relief ratio'], ['At analysis point', fmt(pz.elevation[0], 0), 'm']])}
      <h3>Hypsometric curve</h3><div class="chart"><canvas id="chHyps" aria-label="Hypsometric curve"></canvas></div>
      <p class="note">Fraction of sampled elevations above each level, from ${h.n} interior lattice points. The hypsometric integral is a descriptive elevation–relief ratio, not a calibrated measure of erosion, landslide susceptibility or flood risk.</p>
      <div class="row"><button class="btn" id="btnFitDem" type="button">Show elevation map with this range</button><button class="btn ghost" id="btnSlope" type="button">Show slope map</button></div>
      <p class="src">Copernicus DEM GLO-90 (ESA, 2021) via Open-Meteo Elevation API. Lattice of ${h.n} points; statistics of a regular sample, not of every pixel.</p>`;
    const sorted = ST.finite(d.elevation).sort((a, b) => a - b);
    chart('chHyps', { type: 'line', data: { datasets: [{ label: 'Elevation (m)', data: h.curve.map((c, i) => ({ x: c.a * 100, y: sorted[i] })), borderColor: css('--sienna'), pointRadius: 0, fill: false, tension: 0.1 }] },
      options: { parsing: false, scales: { x: { type: 'linear', min: 0, max: 100, title: { display: true, text: 'Sampled elevations above this level (%)' } }, y: { title: { display: true, text: 'Elevation (m)' } } }, plugins: { legend: { display: false } } } });
    $('#btnFitDem').addEventListener('click', fitDemToDistrict);
    $('#btnSlope').addEventListener('click', () => { if (!S.overlays.has('dem_slope')) { $('#ov-dem_slope').checked = true; toggleOverlay(C.OVERLAYS.find((x) => x.id === 'dem_slope'), true); } });
  }

  // ---- Soil
  // SoilGrids mapped-unit conversion factors (ISRIC SoilGrids FAQ): value / factor -> conventional unit
  const SOIL_FACTORS = { clay: [10, '%'], sand: [10, '%'], silt: [10, '%'], soc: [10, 'g/kg'], phh2o: [10, 'pH'], bdod: [100, 'kg/dm³'], cec: [10, 'cmol(c)/kg'], nitrogen: [100, 'g/kg'] };
  /** Fallback when the beta REST API is paused: one WMS GetFeatureInfo per property, all six depths at once. */
  async function soilViaWms(lat, lon, props) {
    const d = 0.001, P = {};
    await Promise.all(props.map(async (prop) => {
      const layers = C.SOIL_DEPTHS.map((z) => `${prop}_${z}_mean`).join(',');
      const url = `${C.ISRIC}${prop}.map&${A.qs({ SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetFeatureInfo', LAYERS: layers, QUERY_LAYERS: layers, STYLES: '', SRS: 'EPSG:4326',
        BBOX: `${lon - d},${lat - d},${lon + d},${lat + d}`, WIDTH: 3, HEIGHT: 3, X: 1, Y: 1, INFO_FORMAT: 'text/plain', FEATURE_COUNT: 1 })}`;
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
      const txt = await (await fetch(url, { signal: ctl.signal })).text(); clearTimeout(t);
      P[prop] = parseSoilFeatureInfo(txt, prop);
    }));
    S.log.push({ label: 'SoilGrids WMS GetFeatureInfo (fallback)', url: C.ISRIC, fetched_utc: new Date().toISOString(), cached: false });
    return P;
  }
  function parseSoilFeatureInfo(txt, prop) {
    const [f, unit] = SOIL_FACTORS[prop];
    const blocks = txt.split(/Layer\s+'/).slice(1);
    const byLayer = {};
    blocks.forEach((b) => { const name = b.slice(0, b.indexOf("'")); const m = b.match(/value_0\s*=\s*'?(-?\d+(?:\.\d+)?)/); byLayer[name] = m ? +m[1] : NaN; });
    return { unit, depths: C.SOIL_DEPTHS.map((z) => { const v = byLayer[`${prop}_${z}_mean`]; return { label: z, mean: Number.isFinite(v) && v > 0 ? v / f : NaN, q05: NaN, q95: NaN }; }) };
  }
  async function tabSoil(panel, alive) {
    const props = ['clay', 'sand', 'silt', 'soc', 'phh2o', 'bdod', 'cec', 'nitrogen'];
    const url = `${C.API.soilProps}?${A.qs({ lon: pt().lon, lat: pt().lat, 'property[]': props, 'depth[]': C.SOIL_DEPTHS, 'value[]': ['mean', 'Q0.05', 'Q0.95'] })}`;
    let P = {}, via = 'REST';
    try {
      const d = await get(url, { ttl: 864e5 * 180, timeout: 30e3, retries: 0 }, 'SoilGrids properties (REST)'); if (!alive()) return;
      d.properties.layers.forEach((l) => {
        const df = l.unit_measure.d_factor || 1;
        P[l.name] = { unit: l.unit_measure.target_units, depths: l.depths.map((x) => ({ label: x.label, mean: x.values.mean == null ? NaN : x.values.mean / df, q05: x.values['Q0.05'] == null ? NaN : x.values['Q0.05'] / df, q95: x.values['Q0.95'] == null ? NaN : x.values['Q0.95'] / df })) };
      });
    } catch (restErr) {
      if (!alive()) return;
      panel.innerHTML = `<p class="note">SoilGrids REST API unavailable (${esc(restErr.message)}); reading the SoilGrids map service instead…</p>${skeleton(3)}`;
      P = await soilViaWms(+pt().lat, +pt().lon, props); via = 'WMS'; if (!alive()) return;
    }
    if (!P.clay || P.clay.depths.every((x) => !Number.isFinite(x.mean))) {
      panel.innerHTML = '<p class="warn">SoilGrids has no prediction at this point (water, built-up or rock are masked).</p><p>Tap the map to choose another analysis point inside the district.</p>';
      return;
    }
    const tex = C.SOIL_DEPTHS.map((_, i) => ST.usdaTexture(P.sand.depths[i].mean, P.silt.depths[i].mean, P.clay.depths[i].mean));
    let wrb = null;
    if (via === 'REST') try { wrb = await get(`${C.API.soilClass}?lon=${pt().lon}&lat=${pt().lat}&number_classes=3`, { ttl: 864e5 * 180, retries: 1 }, 'SoilGrids WRB class'); } catch (_) {}
    if (!alive()) return;
    const top = (k) => P[k] ? P[k].depths[0].mean : NaN;
    props.forEach((k) => P[k] && record('Soil', `${k} 0-5 cm (mean)`, top(k), P[k].unit, 'ISRIC SoilGrids 2.0'));
    record('Soil', 'USDA texture 0-5 cm', tex[0], 'class', 'Derived from SoilGrids sand/silt/clay');
    if (wrb && wrb.wrb_class_name) record('Soil', 'WRB reference group', wrb.wrb_class_name, 'class', 'ISRIC SoilGrids 2.0');
    const rows = props.filter((k) => P[k]).map((k) => `<tr><td>${esc(C.SOIL_PROPS[k] ? C.SOIL_PROPS[k].label : k)}</td><td>${esc(P[k].unit)}</td>${P[k].depths.map((x) => `<td class="n" title="90 % interval ${fmt(x.q05, 1)}–${fmt(x.q95, 1)}">${fmt(x.mean, k === 'phh2o' || k === 'bdod' ? 2 : 1)}</td>`).join('')}</tr>`).join('');
    panel.innerHTML = `${kv([['Texture, 0–5 cm', esc(tex[0])], ['Texture, 30–60 cm', esc(tex[3])], ['WRB soil group', wrb && wrb.wrb_class_name ? esc(wrb.wrb_class_name) : 'n/a', '', wrb && wrb.wrb_class_probability ? wrb.wrb_class_probability.map(([c, p]) => `${esc(c)} ${p}%`).join(', ') : ''], ['pH, 0–5 cm', fmt(top('phh2o'), 1)]])}
      <h3>Particle size with depth</h3><div class="chart"><canvas id="chTex" aria-label="Sand silt clay by depth"></canvas></div>
      <h3>Profile (mean; hover for 90 % prediction interval)</h3><div style="overflow-x:auto"><table class="data"><thead><tr><th>Property</th><th>Unit</th>${C.SOIL_DEPTHS.map((x) => `<th class="n">${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">Clay-rich, low-permeability horizons raise runoff and swelling hazards; sandy soils drain fast and dry out quickly. Bulk density above about 1.6 kg/dm³ restricts roots in most textures.</p>
      <p class="src">ISRIC SoilGrids 2.0 at 250 m (Poggio et al., 2021, SOIL 7:217–240), CC BY 4.0, read through the ${via === 'REST' ? 'REST API' : 'WMS map service because the beta REST API did not respond; prediction intervals and WRB probabilities are not available this way'}. Values are machine-learning predictions, not field measurements. Texture class from the USDA triangle.</p>`;
    chart('chTex', { type: 'bar', data: { labels: C.SOIL_DEPTHS, datasets: [['Sand', 'sand', '#d8b365'], ['Silt', 'silt', '#9c9c7a'], ['Clay', 'clay', '#8c510a']].map(([n, k, c]) => ({ label: n, data: P[k].depths.map((x) => x.mean), backgroundColor: c })) },
      options: { indexAxis: 'y', scales: { x: { stacked: true, max: 100, title: { display: true, text: '% of fine earth' } }, y: { stacked: true, reverse: false } } } });
  }

  // ---- Climate (ERA5)
  async function tabClimate(panel, alive) {
    const end = daysAgo(7);
    const url = `${C.API.archive}?${A.qs({ latitude: pt().lat, longitude: pt().lon, start_date: '1981-01-01', end_date: end, daily: ['temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean', 'precipitation_sum'], timezone: 'Asia/Kolkata', models: 'era5' })}`;
    panel.innerHTML = `<p class="note">Fetching 45 years of daily ERA5 data (about 66 000 values)…</p>${skeleton(5)}`;
    const d = await get(url, { ttl: 864e5 * 7, timeout: 90e3 }, 'ERA5 daily 1981-present'); if (!alive()) return;
    const t = d.daily.time, tx = d.daily.temperature_2m_max, tn = d.daily.temperature_2m_min, tm = d.daily.temperature_2m_mean, pr = d.daily.precipitation_sum;
    const mP = ST.toMonthly(t, pr, 'sum'), mT = ST.toMonthly(t, tm, 'mean');
    const cP = ST.climatology(mP), cT = ST.climatology(mT);
    const ann = ST.annualIndices(t, tx, tn, tm, pr);
    const yrs = ann.map((r) => r.year);
    const trend = (k) => ST.mannKendall(yrs, ann.map((r) => r[k]));
    const tT = trend('Tmean'), tP = trend('PRCPTOT');
    const spi3 = ST.spi(mP, 3), spi12 = ST.spi(mP, 12);
    const last3 = spi3[spi3.length - 1], last12 = spi12[spi12.length - 1];
    const gum = ST.gumbelLMoments(ann.map((r) => r.Rx1day));
    const annP = ST.mean(ann.filter((r) => r.year >= 1991 && r.year <= 2020).map((r) => r.PRCPTOT));
    record('Climate', 'Mean annual temperature 1991-2020', ST.mean(ann.filter((r) => r.year >= 1991 && r.year <= 2020).map((r) => r.Tmean)), 'degC', 'ERA5');
    record('Climate', 'Mean annual wet-day precipitation 1991-2020', annP, 'mm', 'ERA5');
    record('Climate', 'Tmean trend (Sen)', tT.slope * 10, 'degC/decade', `ERA5, Mann-Kendall nominal iid p=${tT.p.toFixed(4)}`);
    record('Climate', 'PRCPTOT trend (Sen)', tP.slope * 10, 'mm/decade', `ERA5, Mann-Kendall nominal iid p=${tP.p.toFixed(4)}`);
    record('Climate', `SPI-3 (${last3.y}-${String(last3.m).padStart(2, '0')})`, last3.spi, '-', 'McKee et al. (1993), gamma fit 1991-2020');
    record('Climate', `SPI-12 (${last12.y}-${String(last12.m).padStart(2, '0')})`, last12.spi, '-', 'McKee et al. (1993), gamma fit 1991-2020');
    if (gum) gum.levels.forEach((l) => record('Climate', `Rx1day ${l.T}-yr return level`, l.value, 'mm', 'Gumbel, L-moments (Hosking 1990), ERA5 annual maxima'));
    const IND = [['TXx', 'Hottest day', '°C'], ['TNn', 'Coldest night', '°C'], ['TX40', 'Days with Tmax ≥ 40 °C', 'days'], ['Rx1day', 'Wettest day', 'mm'], ['R20mm', 'Days with ≥ 20 mm', 'days'], ['CDD', 'Longest dry spell (< 1 mm)', 'days'], ['PRCPTOT', 'Wet-day total', 'mm']];
    const rows = IND.map(([k, n, u]) => { const r = trend(k); record('Climate', `${k} trend (Sen)`, r.slope * 10, `${u}/decade`, `Mann-Kendall nominal iid p=${r.p.toFixed(4)}`);
      return `<tr><td>${n}</td><td class="n">${fmt(ST.mean(ann.filter((x) => x.year >= 1991 && x.year <= 2020).map((x) => x[k])), 1)}</td><td class="n">${r.slope >= 0 ? '+' : ''}${fmt(r.slope * 10, 2)}</td><td class="n">${r.p < 0.05 ? `<b>${sig(r.p)}</b>` : sig(r.p)}</td></tr>`; }).join('');
    const spiTag = (s) => pill(ST.spiClass(s.spi), s.spi <= -1.5 || s.spi >= 1.5 ? 'alert' : '');
    panel.innerHTML = `${kv([['Warming trend', `${tT.slope >= 0 ? '+' : ''}${fmt(tT.slope * 10, 2)}`, '°C / decade', `${sig(tT.p)}, ${tT.n} years`], ['Rain trend', `${tP.slope >= 0 ? '+' : ''}${fmt(tP.slope * 10, 0)}`, 'mm / decade', `${sig(tP.p)}; normal ${fmt(annP, 0)} mm/yr`],
      ['SPI-3', fmt(last3.spi, 2), '', `${spiTag(last3)} 3 months to ${last3.y}-${String(last3.m).padStart(2, '0')}`], ['SPI-12', fmt(last12.spi, 2), '', `${spiTag(last12)} 12 months to ${last12.y}-${String(last12.m).padStart(2, '0')}`]])}
      <h3>Monthly normal 1991–2020 and the last 12 months</h3><div class="chart tall"><canvas id="chClim" aria-label="Monthly climatology"></canvas></div>
      <h3>Annual mean temperature with Sen's slope</h3><div class="chart"><canvas id="chTrend" aria-label="Annual temperature trend"></canvas></div>
      <h3>Drought and wetness: SPI, last 36 months</h3><div class="chart"><canvas id="chSpi" aria-label="Standardised precipitation index"></canvas></div>
      <h3>Climate extremes (ETCCDI-style)</h3><table class="data"><thead><tr><th>Index</th><th class="n">Normal</th><th class="n">Trend per decade</th><th class="n">Nominal p (iid)</th></tr></thead><tbody>${rows}</tbody></table>
      ${gum ? `<h3>Extreme daily rain, return levels</h3><table class="data"><thead><tr>${gum.levels.map((l) => `<th class="n">${l.T}-yr</th>`).join('')}</tr></thead><tbody><tr>${gum.levels.map((l) => `<td class="n">${fmt(l.value, 0)} mm</td>`).join('')}</tr></tbody></table><p class="note">Gumbel distribution fitted by L-moments to ${gum.n} annual maxima. Assumes a stationary climate; reanalysis smooths local cloudbursts, so station extremes are usually larger.</p>` : ''}
      <h3>Humid heat: daily maximum wet-bulb temperature</h3><div id="twBox">${skeleton(2)}</div>
      <p class="src">ERA5 reanalysis (Hersbach et al., 2020) at 0.25°, nearest grid cell, via Open-Meteo, ${t[0]} to ${t[t.length - 1]}. Trends: conventional Mann–Kendall test with tie correction and Sen's slope (years with ≥ 90 % valid days). Its nominal p-values assume independent annual observations; serial correlation and multiple comparisons are not adjusted, so treat them as exploratory rather than confirmatory. SPI: gamma fit per calendar month on 1991–2020 (McKee et al., 1993); accumulation windows containing missing months are omitted. Reanalysis trends can contain artefacts from changes in the observing system.</p>`;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const lastP = mP.filter((r) => Number.isFinite(r.v)).slice(-12), lastT = mT.filter((r) => Number.isFinite(r.v)).slice(-12);
    const byM = (arr) => months.map((_, i) => { const r = arr.find((x) => x.m === i + 1); return r ? r.v : null; });
    chart('chClim', { data: { labels: months, datasets: [
      { type: 'bar', label: 'Rain normal (mm)', data: cP.map((c) => c.mean), backgroundColor: css('--blue-soft'), borderColor: css('--blue'), borderWidth: 1, yAxisID: 'y' },
      { type: 'bar', label: 'Rain, last 12 months', data: byM(lastP), backgroundColor: css('--blue'), yAxisID: 'y' },
      { type: 'line', label: 'Temperature normal (°C)', data: cT.map((c) => c.mean), borderColor: css('--sienna'), pointRadius: 2, yAxisID: 'y1' },
      { type: 'line', label: 'Temperature, last 12 months', data: byM(lastT), borderColor: css('--alert'), borderDash: [4, 3], pointRadius: 2, yAxisID: 'y1' }] },
      options: { scales: { y: { position: 'left', title: { display: true, text: 'mm' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '°C' } } } } });
    chart('chTrend', { type: 'line', data: { labels: yrs, datasets: [
      { label: 'Annual mean (°C)', data: ann.map((r) => r.Tmean), borderColor: css('--sienna'), pointRadius: 2 },
      { label: `Sen's slope ${fmt(tT.slope * 10, 2)} °C/decade`, data: yrs.map((y) => tT.intercept + tT.slope * y), borderColor: css('--ink'), borderDash: [5, 4], pointRadius: 0 }] } });
    climateHumidHeat(alive, end).catch((err) => { if (alive()) $('#twBox').innerHTML = `<p class="note">Wet-bulb series unavailable: ${esc(err.message)}</p>`; });
    const s3 = spi3.slice(-36), s12 = spi12.slice(-36);
    chart('chSpi', { data: { labels: s3.map((r) => `${r.y}-${String(r.m).padStart(2, '0')}`), datasets: [
      { type: 'bar', label: 'SPI-3', data: s3.map((r) => r.spi), backgroundColor: s3.map((r) => (r.spi < 0 ? '#b8732d' : '#2c7fb8')) },
      { type: 'line', label: 'SPI-12', data: s12.map((r) => r.spi), borderColor: css('--ink'), pointRadius: 0 }] },
      options: { scales: { y: { suggestedMin: -2.5, suggestedMax: 2.5, title: { display: true, text: 'standard deviations' } } } } });
  }

  /** ERA5 daily maximum wet-bulb temperature: annual maximum (TWx) and days >= 28 C, with Mann-Kendall trends. */
  async function climateHumidHeat(alive, end) {
    const url = `${C.API.archive}?${A.qs({ latitude: pt().lat, longitude: pt().lon, start_date: '1981-01-01', end_date: end, daily: 'wet_bulb_temperature_2m_max', timezone: 'Asia/Kolkata', models: 'era5' })}`;
    const d = await get(url, { ttl: 864e5 * 7, timeout: 90e3, retries: 1 }, 'ERA5 daily max wet-bulb 1981-present'); if (!alive()) return;
    const t = d.daily.time, tw = d.daily.wet_bulb_temperature_2m_max;
    const yrs = new Map(); t.forEach((x, i) => { const y = +x.slice(0, 4); if (!yrs.has(y)) yrs.set(y, []); yrs.get(y).push(tw[i]); });
    const rows = [...yrs.entries()].filter(([, v]) => ST.finite(v).length >= 330).map(([y, v]) => ({ y, twx: Math.max(...ST.finite(v)), d28: ST.finite(v).filter((x) => x >= 28).length }));
    const mk1 = ST.mannKendall(rows.map((r) => r.y), rows.map((r) => r.twx)), mk2 = ST.mannKendall(rows.map((r) => r.y), rows.map((r) => r.d28));
    const norm = rows.filter((r) => r.y >= 1991 && r.y <= 2020);
    record('Climate', 'TWx (annual max wet-bulb) normal 1991-2020', ST.mean(norm.map((r) => r.twx)), 'degC', 'ERA5 daily max wet-bulb');
    record('Climate', 'TWx trend (Sen)', mk1.slope * 10, 'degC/decade', `Mann-Kendall nominal iid p=${mk1.p.toFixed(4)}`);
    record('Climate', 'Days with Tw >= 28 C, trend (Sen)', mk2.slope * 10, 'days/decade', `Mann-Kendall nominal iid p=${mk2.p.toFixed(4)}`);
    $('#twBox').innerHTML = `${kv([['Hottest humid day (TWx), normal', fmt(ST.mean(norm.map((r) => r.twx)), 1), '°C', `trend ${mk1.slope >= 0 ? '+' : ''}${fmt(mk1.slope * 10, 2)} °C/decade, ${sig(mk1.p)}`],
      ['Days with wet-bulb ≥ 28 °C', fmt(ST.mean(norm.map((r) => r.d28)), 0), 'per year', `trend ${mk2.slope >= 0 ? '+' : ''}${fmt(mk2.slope * 10, 1)} days/decade, ${sig(mk2.p)}`]])}
      <div class="chart"><canvas id="chTw" aria-label="Annual maximum wet-bulb temperature"></canvas></div>
      <p class="note">Reanalysis smooths local peaks: station wet-bulb maxima are typically higher, and 0.25° cells mix coast and inland. Wet-bulb from ERA5 hourly temperature and humidity, aggregated by Open-Meteo.</p>`;
    chart('chTw', { data: { labels: rows.map((r) => r.y), datasets: [
      { type: 'line', label: 'TWx (°C)', data: rows.map((r) => r.twx), borderColor: css('--alert'), pointRadius: 2, yAxisID: 'y' },
      { type: 'bar', label: 'Days ≥ 28 °C', data: rows.map((r) => r.d28), backgroundColor: css('--blue-soft'), yAxisID: 'y1' }] },
      options: { scales: { y: { title: { display: true, text: '°C' } }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'days' } } } } });
  }

  // ---- Weather
  function loadForecast() {
    return get(`${C.API.forecast}?${A.qs({ latitude: pt().lat, longitude: pt().lon, current: ['temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'precipitation', 'wind_speed_10m', 'wind_direction_10m'],
      hourly: ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m'], daily: ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'wind_gusts_10m_max', 'et0_fao_evapotranspiration', 'uv_index_max'],
      past_days: 1, forecast_days: 7, timezone: 'Asia/Kolkata' })}`, { ttl: 30 * 60e3 }, 'Weather forecast');
  }
  async function tabWeather(panel, alive) {
    const w = await loadForecast(); if (!alive()) return;
    const H = w.hourly, i0 = hourIndex(H.time);
    const tw = H.temperature_2m.map((t, i) => ST.wetBulbStull(t, H.relative_humidity_2m[i]));
    const hi = H.temperature_2m.map((t, i) => ST.heatIndex(t, H.relative_humidity_2m[i]));
    const sl = (a) => a.slice(i0, i0 + 168);
    const twMax = Math.max(...ST.finite(sl(tw))), hiMax = Math.max(...ST.finite(sl(hi)));
    const hiCat = (v) => (v >= 54 ? 'Extreme danger' : v >= 41 ? 'Danger' : v >= 32 ? 'Extreme caution' : v >= 27 ? 'Caution' : 'No heat stress');
    record('Weather', 'Max wet-bulb temperature, 7 days', twMax, 'degC', 'Stull (2011) from forecast T and RH');
    record('Weather', 'Max heat index, 7 days', hiMax, 'degC', 'NWS Rothfusz (1990)');
    const D = w.daily;
    D.time.forEach((day, i) => record('Weather', `Rain ${day}`, D.precipitation_sum[i], 'mm', 'Open-Meteo forecast'));
    panel.innerHTML = `${kv([['Now', fmt(w.current.temperature_2m, 1), '°C', `RH ${fmt(w.current.relative_humidity_2m, 0)} %, wind ${fmt(w.current.wind_speed_10m, 0)} km/h`],
      ['Max wet-bulb, 7 days', fmt(twMax, 1), '°C', twMax >= 31 ? pill('Beyond safe sustained exertion', 'alert') : pill(twMax >= 28 ? 'High' : 'Moderate')],
      ['Max heat index, 7 days', fmt(hiMax, 1), '°C', pill(hiCat(hiMax), hiMax >= 41 ? 'alert' : '')],
      ['Rain, 7 days', fmt(ST.sum(ST.finite(D.precipitation_sum.slice(1))), 0), 'mm']])}
      <h3>Hourly temperature, wet-bulb and rain</h3><div class="chart tall"><canvas id="chWx" aria-label="Hourly forecast"></canvas></div>
      <h3>Daily outlook</h3><div style="overflow-x:auto"><table class="data"><thead><tr><th>Day</th><th class="n">Min/Max °C</th><th class="n">Rain mm</th><th>IMD class</th><th class="n">Chance</th><th class="n">Gust km/h</th><th class="n">ET₀ mm</th></tr></thead><tbody>
      ${D.time.map((day, i) => `<tr${i === 0 ? ' style="opacity:.6"' : ''}><td>${new Date(day + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</td><td class="n">${fmt(D.temperature_2m_min[i], 0)}/${fmt(D.temperature_2m_max[i], 0)}</td><td class="n">${fmt(D.precipitation_sum[i], 1)}</td><td>${ST.imdRainClass(D.precipitation_sum[i])}</td><td class="n">${fmt(D.precipitation_probability_max[i], 0)} %</td><td class="n">${fmt(D.wind_gusts_10m_max[i], 0)}</td><td class="n">${fmt(D.et0_fao_evapotranspiration[i], 1)}</td></tr>`).join('')}</tbody></table></div>
      <p class="note">Wet-bulb temperature combines heat and humidity; laboratory work (Vecellio et al., 2022) puts the limit for sustained exertion near 31 °C in humid heat, lower for older people. IMD 24-hour rainfall classes: heavy 64.5–115.5 mm, very heavy 115.6–204.4 mm, extremely heavy ≥ 204.5 mm. First row is yesterday.</p>
      <p class="src">Open-Meteo forecast API (best-match blend of national and global NWP models, including ECMWF IFS and NCEP GFS), CC BY 4.0. Wet-bulb by Stull (2011); heat index by NWS Rothfusz regression.</p>`;
    const lab = sl(H.time).map((x) => x.slice(5, 13).replace('T', ' '));
    chart('chWx', { data: { labels: lab, datasets: [
      { type: 'line', label: 'Air temperature (°C)', data: sl(H.temperature_2m), borderColor: css('--sienna'), pointRadius: 0, yAxisID: 'y' },
      { type: 'line', label: 'Wet-bulb (°C)', data: sl(tw), borderColor: css('--alert'), pointRadius: 0, yAxisID: 'y' },
      { type: 'bar', label: 'Rain (mm/h)', data: sl(H.precipitation), backgroundColor: css('--blue'), yAxisID: 'y1' }] },
      options: { scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { title: { display: true, text: '°C' } }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'mm/h' } } } } });
  }

  // ---- Air
  function loadAir() {
    return get(`${C.API.air}?${A.qs({ latitude: pt().lat, longitude: pt().lon, hourly: ['pm2_5', 'pm10', 'nitrogen_dioxide', 'sulphur_dioxide', 'ozone', 'carbon_monoxide'], past_days: 2, forecast_days: 4, timezone: 'Asia/Kolkata' })}`, { ttl: 60 * 60e3 }, 'CAMS air quality');
  }
  function naqiFrom(aq, endIdx) {
    const H = aq.hourly, from = Math.max(0, endIdx - 23), win = (k) => H[k].slice(from, endIdx + 1);
    return ST.naqi({ pm25: ST.mean(win('pm2_5')), pm10: ST.mean(win('pm10')), no2: ST.mean(win('nitrogen_dioxide')), so2: ST.mean(win('sulphur_dioxide')),
      o3: ST.maxRunningMean(win('ozone'), 8), co: ST.maxRunningMean(win('carbon_monoxide').map((v) => v / 1000), 8) });
  }
  async function tabAir(panel, alive) {
    const aq = await loadAir(); if (!alive()) return;
    const H = aq.hourly, i0 = hourIndex(H.time), now = naqiFrom(aq, i0);
    const days = [1, 2, 3].map((k) => ({ k, end: i0 + 24 * k, r: naqiFrom(aq, Math.min(H.time.length - 1, i0 + 24 * k)) }));
    record('Air', 'NAQI (past 24 h, CAMS)', now.value, '-', 'CPCB (2014) method on CAMS model concentrations');
    record('Air', 'PM2.5 24-h mean', ST.mean(H.pm2_5.slice(Math.max(0, i0 - 23), i0 + 1)), 'ug/m3', 'CAMS via Open-Meteo');
    const names = { pm25: 'PM2.5', pm10: 'PM10', no2: 'NO₂', so2: 'SO₂', o3: 'O₃ (8 h)', co: 'CO (8 h)' };
    panel.innerHTML = `${kv([['Air quality index, past 24 h', Number.isFinite(now.value) ? now.value : 'n/a', '', `${pill(now.category, now.value > 200 ? 'alert' : now.value <= 100 ? 'okc' : '')} dominant ${esc(names[now.dominant] || '–')}`],
      ...days.map((d) => [`Outlook, 24 h ending +${d.k * 24} h`, Number.isFinite(d.r.value) ? d.r.value : 'n/a', '', pill(d.r.category, d.r.value > 200 ? 'alert' : '')])])}
      <h3>Particulate matter, hourly</h3><div class="chart tall"><canvas id="chAq" aria-label="PM2.5 and PM10"></canvas></div>
      <h3>Sub-indices (past 24 h)</h3><table class="data"><thead><tr><th>Pollutant</th><th class="n">Sub-index</th><th>Band</th></tr></thead><tbody>
      ${Object.entries(now.subs).map(([k, v]) => `<tr><td>${names[k]}</td><td class="n">${fmt(v, 0)}</td><td>${ST.naqiCategory(v)}</td></tr>`).join('')}</tbody></table>
      <p class="note">Index computed with the CPCB National AQI breakpoints (2014) from model concentrations: 24-hour means for PM, NO₂, SO₂ and the highest 8-hour mean for O₃ and CO. Dashed lines: Indian NAAQS 24-hour limits (PM2.5 60, PM10 100 µg/m³) and WHO 2021 guidelines (15 and 45 µg/m³).</p>
      <p class="warn">This is a global model at about 40 km resolution, not a CPCB station reading. It often underestimates urban peaks and winter smog in the Indo-Gangetic Plain.</p>
      <p class="src">Copernicus Atmosphere Monitoring Service global forecast via Open-Meteo Air Quality API, CC BY 4.0.</p>`;
    const lab = H.time.map((x) => x.slice(5, 13).replace('T', ' '));
    const flat = (v) => H.time.map(() => v);
    chart('chAq', { type: 'line', data: { labels: lab, datasets: [
      { label: 'PM2.5', data: H.pm2_5, borderColor: css('--alert'), pointRadius: 0 }, { label: 'PM10', data: H.pm10, borderColor: css('--sienna'), pointRadius: 0 },
      { label: 'NAAQS PM2.5 (60)', data: flat(60), borderColor: css('--alert'), borderDash: [6, 4], borderWidth: 1, pointRadius: 0 },
      { label: 'WHO PM2.5 (15)', data: flat(15), borderColor: css('--muted'), borderDash: [2, 3], borderWidth: 1, pointRadius: 0 }] },
      options: { scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true, title: { display: true, text: 'µg/m³' } } } } });
  }

  // ---- Rivers (GloFAS)
  /** Search a 3 x 3 lattice (+-0.1 deg, as Open-Meteo recommends for the 5 km GloFAS grid) for the largest river. */
  async function snapToRiver() {
    const [lat0, lon0] = S.point, offs = [-0.1, 0, 0.1], cand = [];
    offs.forEach((dy) => offs.forEach((dx) => cand.push([+(lat0 + dy).toFixed(4), +(lon0 + dx).toFixed(4)])));
    const url = `${C.API.flood}?latitude=${cand.map((c) => c[0]).join(',')}&longitude=${cand.map((c) => c[1]).join(',')}&daily=river_discharge&start_date=${daysAgo(366)}&end_date=${daysAgo(1)}`;
    let d = await get(url, { ttl: 864e5 }, 'GloFAS river search (9 cells)'); if (!Array.isArray(d)) d = [d];
    const scores = d.map((r, i) => ({ i, q: ST.mean(r.daily.river_discharge), lat: r.latitude, lon: r.longitude }))
      .filter((r) => Number.isFinite(r.q) && G.contains(S.selDist.geometry, cand[r.i][1], cand[r.i][0]));
    if (!scores.length) { toast('No GloFAS river cell found inside the district near this point.'); return; }
    const best = scores.reduce((x, y) => (y.q > x.q ? y : x));
    toast(`Moved to the GloFAS cell with mean flow ${fmt(best.q, 0)} m³/s over the last year.`);
    setPoint(L.latLng(cand[best.i][0], cand[best.i][1]));
  }
  async function tabRivers(panel, alive) {
    const base = { latitude: pt().lat, longitude: pt().lon };
    const hist = await get(`${C.API.flood}?${A.qs({ ...base, daily: 'river_discharge', start_date: '1984-01-01', end_date: daysAgo(1) })}`, { ttl: 864e5 * 7, timeout: 60e3 }, 'GloFAS v4 seamless 1984-present');
    if (!alive()) return;
    const fc = await get(`${C.API.flood}?${A.qs({ ...base, daily: ['river_discharge', 'river_discharge_median', 'river_discharge_min', 'river_discharge_max', 'river_discharge_p25', 'river_discharge_p75'], past_days: 60, forecast_days: 30 })}`, { ttl: 3 * 3600e3 }, 'GloFAS ensemble forecast');
    if (!alive()) return;
    const t = hist.daily.time, q = hist.daily.river_discharge;
    const years = new Map(); t.forEach((d, i) => { const y = +d.slice(0, 4); if (!years.has(y)) years.set(y, []); years.get(y).push(q[i]); });
    const amax = [...years.entries()].filter(([, v]) => ST.finite(v).length >= 330).map(([y, v]) => ({ y, v: Math.max(...ST.finite(v)) }));
    // thresholds from the consolidated reanalysis years only (complete to 2021); later years come from archived forecasts
    const fitYears = amax.filter((r) => r.y <= 2021);
    const iRe = t.findIndex((d) => d >= '2022-01-01'), qMean = ST.mean(iRe > 0 ? q.slice(0, iRe) : q), gum = ST.gumbelLMoments(fitYears.map((r) => r.v), [2, 5, 20]);
    const F = fc.daily, today = new Date().toISOString().slice(0, 10), iT = Math.max(0, F.time.findIndex((d) => d >= today));
    const stat = (k) => (F[k] || []).map((v) => (Number.isFinite(v) ? v : null));
    const med = F.time.map((_, i) => (F.river_discharge_median && Number.isFinite(F.river_discharge_median[i]) ? F.river_discharge_median[i] : null));
    const sim = F.time.map((_, i) => (i <= iT ? F.river_discharge[i] : null));
    const fcPeakSeries = F.time.map((_, i) => (i >= iT ? (med[i] ?? F.river_discharge[i]) : null));
    const peak = Math.max(...ST.finite(fcPeakSeries)), peakDay = F.time[fcPeakSeries.indexOf(peak)];
    const maxMember = Math.max(...ST.finite(stat('river_discharge_max').slice(iT)));
    const rp = ST.returnPeriod(peak, gum);
    record('Rivers', 'Mean discharge 1984-2021', qMean, 'm3/s', 'GloFAS v4 reanalysis');
    if (gum) gum.levels.forEach((l) => record('Rivers', `${l.T}-yr flood discharge`, l.value, 'm3/s', `Gumbel L-moments, ${gum.n} annual maxima 1984-2021`));
    record('Rivers', 'Peak of ensemble-median forecast (30 d)', peak, 'm3/s', `GloFAS forecast, ${peakDay}`);
    if (Number.isFinite(maxMember)) record('Rivers', 'Highest ensemble member (30 d)', maxMember, 'm3/s', 'GloFAS forecast');
    const lvl = (v) => (!gum ? 'n/a' : v >= gum.levels[2].value ? 'Above 20-year flood' : v >= gum.levels[1].value ? 'Above 5-year flood' : v >= gum.levels[0].value ? 'Above 2-year flood' : 'Below 2-year flood');
    const status = lvl(peak), worst = lvl(maxMember);
    const small = qMean < 5;
    panel.innerHTML = `${small ? '<p class="warn">The analysis point sits on a very small GloFAS channel (mean flow below 5 m³/s), so the hydrograph says little about flooding here.</p>' : ''}
      <p><button class="btn ghost" id="btnSnap" type="button">Move to the largest river within about 10 km</button></p>
      ${kv([['Mean flow, 1984–2021', fmt(qMean, qMean < 10 ? 1 : 0), 'm³/s', `GloFAS cell at ${fmt(fc.latitude, 3)} N, ${fmt(fc.longitude, 3)} E`], ['2 / 5 / 20-yr flood', gum ? gum.levels.map((l) => fmt(l.value, 0)).join(' / ') : 'n/a', 'm³/s', gum ? `Gumbel fit to ${gum.n} annual maxima, 1984–2021` : 'Too few complete years'],
        ['30-day forecast peak (median)', fmt(peak, 0), 'm³/s', `${esc(peakDay || '')}; return period ${Number.isFinite(rp) ? (rp > 500 ? '> 500' : fmt(rp, rp < 10 ? 1 : 0)) + ' yr' : 'n/a'}`],
        ['Flood status', '', '', `${pill(status, /20|5-year/.test(status) ? 'alert' : status.startsWith('Above') ? '' : 'okc')}<br>Wettest ensemble member: ${pill(worst, /20|5-year/.test(worst) ? 'alert' : '')}`]])}
      <h3>Hydrograph: last 60 days and 30-day ensemble forecast</h3><div class="chart tall"><canvas id="chQ" aria-label="River discharge"></canvas></div>
      <h3>Annual maximum discharge</h3><div class="chart"><canvas id="chAmax" aria-label="Annual maxima"></canvas></div>
      <p class="note">Flood levels follow the GloFAS practice of comparing forecasts with thresholds from the model's own reanalysis, so systematic model bias largely cancels. Thresholds use the consolidated reanalysis (1984–2021); later bars (lighter) come from archived forecasts and are shown for context only. Ensemble statistics exist only for forecast days.</p>
      <p class="src">GloFAS v4, Copernicus Emergency Management Service (Harrigan et al., 2020, ESSD 12:2043–2060), via Open-Meteo Flood API (largest river within the 5 km cell), CC BY 4.0. Gumbel by L-moments (Hosking, 1990).</p>`;
    $('#btnSnap').addEventListener('click', () => snapToRiver().catch((e) => toast(`River search failed: ${e.message}`)));
    const L2 = (v) => F.time.map(() => v);
    const ds = [
      { label: 'Ensemble min–max', data: stat('river_discharge_max'), borderColor: 'transparent', backgroundColor: 'rgba(28,93,132,.12)', pointRadius: 0, fill: '+1', spanGaps: false },
      { label: '_min', data: stat('river_discharge_min'), borderColor: 'transparent', pointRadius: 0, fill: false },
      { label: 'Interquartile range', data: stat('river_discharge_p75'), borderColor: 'transparent', backgroundColor: 'rgba(28,93,132,.28)', pointRadius: 0, fill: '+1' },
      { label: '_p25', data: stat('river_discharge_p25'), borderColor: 'transparent', pointRadius: 0, fill: false },
      { label: 'Ensemble median', data: med, borderColor: css('--blue'), pointRadius: 0, borderWidth: 2 },
      { label: 'Simulated (past days)', data: sim, borderColor: css('--ink'), pointRadius: 0, borderWidth: 1.5 }];
    if (gum) gum.levels.forEach((l, i) => ds.push({ label: `${l.T}-yr flood`, data: L2(l.value), borderColor: ['#e0a000', '#d9480f', '#a50f15'][i], borderDash: [6, 4], borderWidth: 1.2, pointRadius: 0 }));
    chart('chQ', { type: 'line', data: { labels: F.time.map((x) => x.slice(5)), datasets: ds },
      options: { plugins: { legend: { labels: { filter: (it) => !it.text.startsWith('_') } } }, scales: { x: { ticks: { maxTicksLimit: 9 } }, y: { beginAtZero: true, title: { display: true, text: 'm³/s' } } } } });
    chart('chAmax', { type: 'bar', data: { labels: amax.map((r) => r.y), datasets: [{ label: 'Annual maximum (m³/s)', data: amax.map((r) => r.v), backgroundColor: amax.map((r) => (r.y <= 2021 ? css('--blue') : css('--blue-soft'))) }] }, options: { plugins: { legend: { display: false } } } });
  }

  // ---- Earthquakes and events
  async function tabHazards(panel, alive) {
    const [w, s, e, n] = S.selDist._bbox, padKm = 150, dLat = padKm / 111.2, dLon = padKm / (111.2 * Math.cos(((s + n) / 2) * Math.PI / 180));
    const box = { minlatitude: (s - dLat).toFixed(3), maxlatitude: (n + dLat).toFixed(3), minlongitude: (w - dLon).toFixed(3), maxlongitude: (e + dLon).toFixed(3) };
    const url = `${C.API.fdsn}?${A.qs({ format: 'geojson', starttime: '1970-01-01', minmagnitude: 2.5, orderby: 'magnitude', limit: 20000, ...box })}`;
    const d = await get(url, { ttl: 864e5, timeout: 60e3 }, 'USGS ComCat search'); if (!alive()) return;
    const ev = d.features.filter((f) => Number.isFinite(f.properties.mag));
    const years = (Date.now() - Date.UTC(1970, 0, 1)) / (365.25 * 864e5);
    const gr = ST.gutenbergRichter(ev.map((f) => f.properties.mag));
    let hazTxt = '';
    if (gr.ok) {
      const firstMc = Math.min(...ev.filter((f) => f.properties.mag >= gr.Mc).map((f) => f.properties.time));
      const T = (Date.now() - firstMc) / (365.25 * 864e5);
      const rate = (m) => Math.pow(10, gr.a - gr.b * m) / T;
      const p50 = (m) => 1 - Math.exp(-rate(m) * 50);
      record('Seismicity', 'Gutenberg-Richter b-value', gr.b, '-', `Aki (1965) MLE, Mc=${gr.Mc}, n=${gr.n}, sigma=${gr.sb.toFixed(3)}`);
      record('Seismicity', 'Magnitude of completeness', gr.Mc, 'M', 'Maximum curvature + 0.2');
      [5, 6, 7].forEach((m) => record('Seismicity', `P(>=1 M${m}+ in 50 yr), search box`, p50(m), 'probability', 'Poisson, G-R extrapolation'));
      hazTxt = `<h3>Recurrence in the search box</h3><table class="data"><thead><tr><th>Magnitude</th><th class="n">Events per century</th><th class="n">Chance of at least one in 50 yr</th></tr></thead><tbody>
        ${[5, 6, 7].map((m) => `<tr><td>M ${m}+</td><td class="n">${fmt(rate(m) * 100, 1)}</td><td class="n">${fmt(p50(m) * 100, 0)} %</td></tr>`).join('')}</tbody></table>
        <p class="note">Poisson recurrence from the Gutenberg–Richter fit over ${fmt(T, 0)} years of complete data, extrapolated beyond observed magnitudes. Use only as a screening indicator; it is not a probabilistic seismic hazard assessment (see IS 1893 zoning and NDMA guidance).</p>`;
    }
    const top = ev.slice(0, 12);
    panel.innerHTML = `${kv([['Events M2.5+ since 1970', ev.length, '', `district box + ${padKm} km`], ['Largest', top[0] ? `M ${fmt(top[0].properties.mag, 1)}` : 'none', '', top[0] ? `${new Date(top[0].properties.time).getUTCFullYear()}, ${esc(top[0].properties.place || '')}` : ''],
      ['b-value', gr.ok ? `${fmt(gr.b, 2)} ± ${fmt(gr.sb, 2)}` : 'n/a', '', gr.ok ? `Mc ${fmt(gr.Mc, 1)}, ${gr.n} events` : `Needs ≥ 30 events above completeness (have ${gr.n})`], ['Mean annual rate M2.5+', fmt(ev.length / years, 1), 'per year']])}
      ${gr.ok ? '<h3>Frequency–magnitude distribution</h3><div class="chart"><canvas id="chGR" aria-label="Gutenberg-Richter plot"></canvas></div>' : ''}
      ${hazTxt}
      <label class="check"><input type="checkbox" id="chkQuakeMap" ${S.seismicLayer ? 'checked' : ''}> Show these earthquakes on the map</label>
      <h3>Largest events</h3><table class="data"><thead><tr><th>Date</th><th class="n">M</th><th class="n">Depth km</th><th>Place</th></tr></thead><tbody>
      ${top.map((f) => `<tr><td>${new Date(f.properties.time).toISOString().slice(0, 10)}</td><td class="n">${fmt(f.properties.mag, 1)}</td><td class="n">${fmt(f.geometry.coordinates[2], 0)}</td><td>${esc(f.properties.place || '')}</td></tr>`).join('') || '<tr><td colspan="4">No events in the catalogue</td></tr>'}</tbody></table>
      <h3>Natural events near the district (NASA EONET, last year)</h3><div id="eonetBox">${skeleton(2)}</div>
      <p class="src">USGS ANSS Comprehensive Catalog via FDSN event service (public domain). Magnitudes mix types (mb, Mw, ML); completeness in South Asia before about 2000 is typically M4–4.5. b-value: Aki (1965) maximum likelihood with Utsu bin correction, uncertainty after Shi & Bolt (1982); completeness by maximum curvature + 0.2 (Woessner & Wiemer, 2005).</p>`;
    if (gr.ok) {
      const fmd = gr.fmd;
      chart('chGR', { type: 'scatter', data: { datasets: [
        { label: 'Cumulative N(≥M)', data: fmd.map((r) => ({ x: r.M, y: r.N })), backgroundColor: css('--sienna'), pointRadius: 3 },
        { label: 'Non-cumulative', data: fmd.map((r) => ({ x: r.M, y: r.n })), backgroundColor: css('--muted'), pointRadius: 2 },
        { type: 'line', label: `log N = ${fmt(gr.a, 2)} − ${fmt(gr.b, 2)} M`, data: fmd.filter((r) => r.M >= gr.Mc).map((r) => ({ x: r.M, y: Math.pow(10, gr.a - gr.b * r.M) })), borderColor: css('--ink'), borderDash: [5, 4], pointRadius: 0 }] },
        options: { scales: { x: { title: { display: true, text: 'Magnitude' } }, y: { type: 'logarithmic', title: { display: true, text: 'Number of events' } } } } });
    }
    $('#chkQuakeMap').addEventListener('change', (e2) => {
      if (S.seismicLayer) { S.map.removeLayer(S.seismicLayer); S.seismicLayer = null; }
      if (e2.target.checked) S.seismicLayer = L.geoJSON({ type: 'FeatureCollection', features: ev }, { pointToLayer: (f, ll) => L.circleMarker(ll, { pane: 'points', radius: 1.5 + 1.4 * Math.max(0, f.properties.mag - 2.5), color: css('--paper'), weight: 0.8, fillColor: css('--alert'), fillOpacity: 0.75 }).bindTooltip(`M ${fmt(f.properties.mag, 1)}, ${new Date(f.properties.time).toISOString().slice(0, 10)}`) }).addTo(S.map);
    });
    try {
      const eo = await get(`${C.API.eonet}?${A.qs({ bbox: `${box.minlongitude},${box.maxlatitude},${box.maxlongitude},${box.minlatitude}`, days: 365, status: 'all', limit: 100 })}`, { ttl: 3 * 3600e3 }, 'NASA EONET (district box)');
      if (!alive()) return;
      $('#eonetBox').innerHTML = eo.events.length ? `<table class="data"><tbody>${eo.events.map((x) => `<tr><td>${esc(x.geometry[0] && x.geometry[0].date.slice(0, 10))}</td><td>${esc(x.categories.map((c) => c.title).join(', '))}</td><td>${esc(x.title)}${x.closed ? '' : ' ' + pill('open', 'alert')}</td></tr>`).join('')}</tbody></table>` : '<p class="note">No EONET events recorded in this box during the last 365 days.</p>';
    } catch (err) { if (alive()) $('#eonetBox').innerHTML = `<p class="note">EONET unavailable: ${esc(err.message)}</p>`; }
  }

  // ---- State pulse (next 72 h) with AHP ranking
  const PULSE = {
    tw_max: { label: 'Max wet-bulb, next 72 h', unit: '°C', breaks: [22, 24, 26, 28, 30, 31], colors: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026'] },
    rain72: { label: 'Rain, next 72 h', unit: 'mm', breaks: [2.5, 15.6, 64.5, 115.6, 204.5], colors: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08519c', '#08306b'] },
    tmax72: { label: 'Max air temperature, next 72 h', unit: '°C', breaks: [25, 30, 35, 37, 40, 45], colors: ['#4575b4', '#91bfdb', '#e0f3f8', '#fee090', '#fc8d59', '#d73027', '#7f0000'] },
    pm25: { label: 'PM2.5, past 24 h mean (CAMS)', unit: 'µg/m³', breaks: [30, 60, 90, 120, 250], colors: ['#1a9850', '#91cf60', '#fee08b', '#fc8d59', '#d73027', '#7f0000'] },
  };
  function pulseColor(metric, v) { const P = PULSE[metric]; let i = 0; while (i < P.breaks.length && v >= P.breaks[i]) i++; return P.colors[i]; }
  function pulseLegend() {
    const P = PULSE[S.pulseMetric];
    const labels = P.colors.map((c, i) => (i === 0 ? `< ${P.breaks[0]}` : i === P.breaks.length ? `≥ ${P.breaks[i - 1]}` : `${P.breaks[i - 1]}–${P.breaks[i]}`));
    return `<div class="card"><b>${esc(P.label)} (${esc(P.unit)})</b>${P.colors.map((c, i) => `<div class="sw"><i style="background:${c}"></i>${labels[i]}</div>`).join('')}</div>`;
  }
  async function loadPulse(state) {
    const cached = S.pulse.get(state); if (cached && Date.now() - cached.t < 30 * 60e3) return cached;
    const fs = S.byState.get(state), P = fs.map(ip);
    const chunks = []; for (let i = 0; i < fs.length; i += 50) chunks.push([i, Math.min(fs.length, i + 50)]);
    const values = {};
    for (const [a, b] of chunks) {
      const lat = P.slice(a, b).map((p) => p[1].toFixed(3)).join(','), lon = P.slice(a, b).map((p) => p[0].toFixed(3)).join(',');
      let wx = await get(`${C.API.forecast}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,precipitation&forecast_days=4&timezone=Asia%2FKolkata`, { ttl: 30 * 60e3 }, `Forecast for ${b - a} districts`);
      let aq = null;
      try { aq = await get(`${C.API.air}?latitude=${lat}&longitude=${lon}&hourly=pm2_5&past_days=1&forecast_days=1&timezone=Asia%2FKolkata`, { ttl: 60 * 60e3 }, `CAMS PM2.5 for ${b - a} districts`); } catch (_) {}
      if (!Array.isArray(wx)) wx = [wx]; if (aq && !Array.isArray(aq)) aq = [aq];
      wx.forEach((w, j) => {
        const f = fs[a + j], H = w.hourly, i0 = hourIndex(H.time), sl = (k) => H[k].slice(i0, i0 + 72);
        const tw = sl('temperature_2m').map((t, i) => ST.wetBulbStull(t, sl('relative_humidity_2m')[i]));
        const v = { tw_max: Math.max(...ST.finite(tw)), tmax72: Math.max(...ST.finite(sl('temperature_2m'))), rain72: ST.sum(ST.finite(sl('precipitation'))), pm25: NaN };
        if (aq && aq[j]) { const A2 = aq[j].hourly, k0 = hourIndex(A2.time); v.pm25 = ST.mean(A2.pm2_5.slice(Math.max(0, k0 - 23), k0 + 1)); }
        values[f._lgd] = v;
      });
    }
    const out = { t: Date.now(), values }; S.pulse.set(state, out); return out;
  }
  function ahpWeights(m) { // principal eigenvector by power iteration; Saaty (1980) consistency ratio, RI(3)=0.58
    const n = m.length; let w = Array(n).fill(1 / n);
    for (let it = 0; it < 100; it++) { const v = m.map((row) => row.reduce((s, x, j) => s + x * w[j], 0)); const s = ST.sum(v); w = v.map((x) => x / s); }
    const lam = ST.mean(m.map((row, i) => row.reduce((s, x, j) => s + x * w[j], 0) / w[i]));
    const CI = (lam - n) / (n - 1); return { w, lam, CI, CR: CI / 0.58 };
  }
  async function tabPulse(panel, alive) {
    const n = S.byState.get(S.selState).length;
    panel.innerHTML = `<p class="note">Requesting forecasts for the interior point of each of ${n} districts…</p>${skeleton(5)}`;
    const pv = await loadPulse(S.selState); if (!alive()) return;
    S.ahp = S.ahp || { a: 0, b: 0, c: 0 };
    panel.innerHTML = `<label class="field">Colour districts by<select id="pulseMetric">${Object.entries(PULSE).map(([k, p]) => `<option value="${k}" ${k === S.pulseMetric ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
      <h3>Priority ranking with your weights</h3>
      <p class="note">Analytic Hierarchy Process (Saaty, 1980). Move a slider toward the hazard that matters more for your decision. Each hazard is rescaled 0–1 across this State's districts, then weighted.</p>
      <div class="ahp"><span class="l">Heat stress</span><input type="range" min="-8" max="8" step="1" data-ahp="a" value="${S.ahp.a}" aria-label="Heat stress versus heavy rain"><span class="r">Heavy rain</span>
        <span class="l">Heat stress</span><input type="range" min="-8" max="8" step="1" data-ahp="b" value="${S.ahp.b}" aria-label="Heat stress versus air pollution"><span class="r">Air pollution</span>
        <span class="l">Heavy rain</span><input type="range" min="-8" max="8" step="1" data-ahp="c" value="${S.ahp.c}" aria-label="Heavy rain versus air pollution"><span class="r">Air pollution</span></div>
      <div id="ahpOut"></div>
      <p class="src">Forecasts: Open-Meteo (CC BY 4.0) at each district's interior point, issued ${new Date(pv.t).toLocaleString('en-IN')}. Wet-bulb by Stull (2011). PM2.5 from CAMS. Rain classes follow IMD 24-hour thresholds, applied here to 72-hour totals for colour only. Single-point values do not capture variation inside large districts.</p>
      <p><button class="btn ghost" data-export="pulse" type="button">Download State table (CSV)</button></p>`;
    $('#pulseMetric').addEventListener('change', (e) => { S.pulseMetric = e.target.value; restyle(); renderLegend(); });
    const draw = () => {
      const sv = (x) => (x >= 0 ? x + 1 : 1 / (1 - x)); // slider -8..8 -> 1/9..9 (right side more important when positive)
      const a = sv(+S.ahp.a), b = sv(+S.ahp.b), c = sv(+S.ahp.c);
      const M = [[1, 1 / a, 1 / b], [a, 1, 1 / c], [b, c, 1]];
      const { w, CR } = ahpWeights(M);
      const fs = S.byState.get(S.selState), keys = ['tw_max', 'rain72', 'pm25'];
      const rng = keys.map((k) => { const v = ST.finite(fs.map((f) => pv.values[f._lgd][k])); return [Math.min(...v), Math.max(...v)]; });
      const rows = fs.map((f) => { const v = pv.values[f._lgd]; const z = keys.map((k, i) => (Number.isFinite(v[k]) && rng[i][1] > rng[i][0] ? (v[k] - rng[i][0]) / (rng[i][1] - rng[i][0]) : 0)); return { f, v, score: z.reduce((s, x, i) => s + x * w[i], 0) }; }).sort((x, y) => y.score - x.score);
      S.pulseRanking = rows; S.pulseWeights = { w, CR };
      $('#ahpOut').innerHTML = `<p>Weights: heat ${fmt(w[0] * 100, 0)} %, rain ${fmt(w[1] * 100, 0)} %, air ${fmt(w[2] * 100, 0)} %. Consistency ratio ${fmt(CR, 3)} ${CR > 0.1 ? pill('Inconsistent (> 0.10): revise the comparisons', 'alert') : pill('Acceptable', 'okc')}</p>
        <div style="overflow-x:auto"><table class="data"><thead><tr><th>#</th><th>District</th><th class="n">Score</th><th class="n">Tw max °C</th><th class="n">Rain mm</th><th class="n">PM2.5</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr data-lgd="${r.f._lgd}"><td>${i + 1}</td><td>${esc(r.f._name)}</td><td class="n">${fmt(r.score, 2)}</td><td class="n">${fmt(r.v.tw_max, 1)}</td><td class="n">${fmt(r.v.rain72, 0)}</td><td class="n">${fmt(r.v.pm25, 0)}</td></tr>`).join('')}</tbody></table></div>`;
    };
    panel.querySelectorAll('[data-ahp]').forEach((s) => s.addEventListener('input', (e) => { S.ahp[e.target.dataset.ahp] = +e.target.value; draw(); }));
    draw(); restyle(); renderLegend();
  }

  // ---- Sources and export
  async function tabSources(panel) {
    panel.innerHTML = `<h3>Data sources</h3><table class="data"><thead><tr><th>Dataset</th><th>Provider and reference</th><th>Licence</th></tr></thead><tbody>
      ${C.SOURCES.map(([a, b, c]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td><td>${esc(c)}</td></tr>`).join('')}</tbody></table>
      <h3>Requests in this session</h3>${S.log.length ? `<table class="data"><tbody>${S.log.slice(-30).reverse().map((l) => `<tr><td>${esc(l.label)}</td><td>${esc(l.fetched_utc.replace('T', ' ').slice(0, 19))} UTC${l.cached ? ' (cache)' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="note">No data requested yet.</p>'}
      <h3>Export</h3><p class="note">Exports contain every value computed in the open tabs, with units, method, analysis point and retrieval times. Open more tabs to include more sections.</p>
      <div class="row"><button class="btn" data-export="all" type="button" ${S.selDist ? '' : 'hidden'}>Compute every section, then download CSV</button><button class="btn ghost" data-export="csv" type="button">Download CSV (open tabs)</button><button class="btn ghost" data-export="json" type="button">Download JSON</button></div><p class="note" id="allStatus"></p>
      <h3>Method notes</h3><p class="note">Boundaries are LGD polygons simplified for the web; areas are computed on a sphere (R = 6 371.0088 km) and agree with official figures to within a few percent. All point analyses use the analysis point shown on the map: by default the pole of inaccessibility of the district's largest part, so it always lies inside the district.</p>`;
  }
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function csvCell(v) { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
  /** Run every district loader in a hidden container so one export holds the full dossier. */
  async function computeAll() {
    if (!S.selDist) return;
    const token = S.token, keys = ['overview', 'terrain', 'soil', 'climate', 'weather', 'air', 'rivers', 'hazards'];
    const fns = { overview: tabOverview, terrain: tabTerrain, soil: tabSoil, climate: tabClimate, weather: tabWeather, air: tabAir, rivers: tabRivers, hazards: tabHazards };
    const box = document.createElement('div'); box.hidden = true; box.setAttribute('aria-hidden', 'true'); document.body.appendChild(box);
    const before = new Set(Object.keys(S.charts)), status = $('#allStatus');
    S.results = [];
    for (const k of keys) {
      if (token !== S.token) break;
      if (status) status.textContent = `Computing ${k}…`;
      const panel = document.createElement('div'); box.appendChild(panel);
      try { await fns[k](panel, () => token === S.token); } catch (err) { record(k, 'section unavailable', String(err.message || err), '', 'request failed'); }
    }
    await new Promise((r) => setTimeout(r, 300)); // let the asynchronous humid-heat block finish writing
    Object.keys(S.charts).filter((id) => !before.has(id)).forEach((id) => { S.charts[id].destroy(); delete S.charts[id]; });
    box.remove();
    if (status) status.textContent = `${S.results.length} values computed.`;
    if (token === S.token) exportData('csv');
  }
  function exportData(kind) {
    if (kind === 'all') { computeAll(); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (kind === 'pulse') {
      const rows = [['state', 'district', 'lgd', 'interior_lat', 'interior_lon', 'tw_max_72h_C', 'tmax_72h_C', 'rain_72h_mm', 'pm25_24h_ugm3', 'ahp_score', 'w_heat', 'w_rain', 'w_air', 'consistency_ratio', 'issued_utc']];
      const pv = S.pulse.get(S.selState); const W = S.pulseWeights || { w: [NaN, NaN, NaN], CR: NaN };
      (S.pulseRanking || []).forEach((r) => { const [x, y] = ip(r.f); rows.push([S.selState, r.f._name, r.f._lgd, y.toFixed(5), x.toFixed(5), r.v.tw_max, r.v.tmax72, r.v.rain72, r.v.pm25, r.score, ...W.w, W.CR, new Date(pv.t).toISOString()]); });
      return download(`openhazard_${S.selState.replace(/\W+/g, '_')}_72h_${stamp}.csv`, '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
    }
    const meta = { app: `OpenHazard India v${C.VERSION}`, generated_utc: new Date().toISOString(), state: S.selState, district: S.selDist ? S.selDist._name : null, lgd: S.selDist ? S.selDist._lgd : null,
      analysis_point: S.point ? { lat: S.point[0], lon: S.point[1], chosen_by_user: S.pointUser } : null, requests: S.log };
    if (kind === 'json') return download(`openhazard_${stamp}.json`, JSON.stringify({ meta, results: S.results }, null, 2), 'application/json');
    const rows = [['state', 'district', 'lgd', 'lat', 'lon', 'section', 'metric', 'value', 'unit', 'method_or_source']];
    S.results.forEach((r) => rows.push([meta.state, meta.district, meta.lgd, meta.analysis_point && meta.analysis_point.lat, meta.analysis_point && meta.analysis_point.lon, r.section, r.metric, r.value, r.unit, r.source]));
    download(`openhazard_${(meta.district || meta.state || 'india').replace(/\W+/g, '_')}_${stamp}.csv`, '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  }

  // ------------------------------------------------------------------ URL hash (deep links)
  let hashLock = false;
  function writeHash() {
    if (hashLock || !S.ready) return;
    const p = new URLSearchParams();
    if (S.selDist) p.set('d', S.selDist._lgd); else if (S.selState) p.set('s', S.selState);
    if (S.pointUser && S.point) p.set('pt', `${S.point[0].toFixed(4)},${S.point[1].toFixed(4)}`);
    if (S.tab && S.tab !== 'overview') p.set('tab', S.tab);
    if (S.base !== S.defaultBase) p.set('base', S.base);
    if (S.overlays.size) p.set('ov', [...S.overlays.keys()].join(','));
    const h = p.toString(); history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1)); hashLock = true;
    if (p.get('base') && C.BASEMAPS[p.get('base')]) setBase(p.get('base'));
    (p.get('ov') || '').split(',').filter(Boolean).forEach((id) => { const d = C.OVERLAYS.find((x) => x.id === id); if (d) { $(`#ov-${id}`).checked = true; toggleOverlay(d, true); } });
    const tab = p.get('tab');
    const ptv = (p.get('pt') || '').split(',').map(Number);
    if (p.get('d') && S.byLgd.has(p.get('d'))) selectDistrict(S.byLgd.get(p.get('d')), { tab, point: ptv.length === 2 && ptv.every(Number.isFinite) ? ptv : null });
    else if (p.get('s')) { selectState(p.get('s')); if (tab) setTab(tab); }
    else buildDossier();
    hashLock = false; writeHash();
  }

  // ------------------------------------------------------------------ UI wiring
  function setSheet(state) { $('#dossier').dataset.sheet = state; setTimeout(() => S.map.invalidateSize(), 260); }
  function wire() {
    $('#basemapSeg').innerHTML = Object.entries(C.BASEMAPS).map(([k, b]) => `<button role="radio" data-key="${k}" aria-checked="${k === S.base}">${esc(b.label)}</button>`).join('');
    $('#basemapSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-key]'); if (b) setBase(b.dataset.key); });
    $('#stateSelect').addEventListener('change', (e) => (e.target.value ? selectState(e.target.value) : selectIndia()));
    $('#districtSelect').addEventListener('change', (e) => (e.target.value ? selectDistrict(S.byLgd.get(e.target.value)) : selectState(S.selState)));
    $('#btnIndia').addEventListener('click', selectIndia);
    $('#btnShare').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied. It reopens this place, tab and layers.'); } catch (_) { toast(location.href, 6000); } });
    ['chkStates', 'chkDistricts', 'chkMask'].forEach((id) => $('#' + id).addEventListener('change', restyle));
    $('#chkLabels').addEventListener('change', updateLabels);
    $('#chkSwipe').addEventListener('change', (e) => setSwipe(e.target.checked));
    $('#btnClearCache').addEventListener('click', () => { A.clearCache(); S.pulse.clear(); if ('caches' in window) caches.keys().then((ks) => ks.filter((k) => k.startsWith('oh-data')).forEach((k) => caches.delete(k))); toast('Cached data cleared.'); });
    const search = $('#placeSearch');
    const go = () => {
      const q = search.value.trim().toLowerCase(); if (!q) return;
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const exact = S.D.find((f) => `${f._name}, ${f._state}`.toLowerCase() === q) || S.D.find((f) => norm(f._name) === norm(q.split(',')[0]));
      const st = [...S.byState.keys()].find((s) => norm(s) === norm(q));
      const fuzzy = exact || S.D.find((f) => norm(f._name).startsWith(norm(q.split(',')[0])));
      if (st && !exact) selectState(st); else if (fuzzy) selectDistrict(fuzzy); else { toast(`No district or State matches “${search.value}”.`); return; }
      search.blur();
    };
    search.addEventListener('change', go);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('#btnLocate').addEventListener('click', () => {
      if (!navigator.geolocation) { toast('This browser cannot share its location.'); return; }
      toast('Finding your location…');
      navigator.geolocation.getCurrentPosition((p) => {
        const { latitude: la, longitude: lo } = p.coords, f = findDistrictAt(la, lo);
        if (!f) { toast('Your location is outside the Indian district boundaries.'); S.map.flyTo([la, lo], 9); return; }
        selectDistrict(f, { point: [la, lo] }); toast(`You are in ${f._name}, ${f._state}. Analysis point set to your location.`);
      }, (err) => toast(`Location unavailable: ${err.message}`), { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
    });
    $('#btnControls').addEventListener('click', () => { const o = $('#controls').classList.toggle('open'); $('#btnControls').setAttribute('aria-expanded', String(o)); });
    const grip = $('#sheetGrip'), order = ['peek', 'half', 'full'];
    grip.addEventListener('click', () => { const i = order.indexOf($('#dossier').dataset.sheet); setSheet(order[(i + 1) % 3]); });
    let y0 = null;
    grip.addEventListener('pointerdown', (e) => { y0 = e.clientY; grip.setPointerCapture(e.pointerId); });
    grip.addEventListener('pointerup', (e) => { if (y0 == null) return; const dy = e.clientY - y0; y0 = null; if (Math.abs(dy) < 25) return; const i = order.indexOf($('#dossier').dataset.sheet); setSheet(order[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]); });
    window.addEventListener('hashchange', () => { if (!hashLock) readHash(); });
    window.addEventListener('resize', () => S.map.invalidateSize());
    S.map.on('zoomend', renderLegend);
    $('#legend').addEventListener('click', () => $('#legend').classList.toggle('min'));
    if (isMobile()) $('#legend').classList.add('min');
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    S.base = S.defaultBase = dark ? 'dark' : 'light';
    initMap(); wire(); buildOverlayPanel();
    try { await loadBoundaries(); }
    catch (err) { $('#dossierSub').textContent = `Boundary files could not be loaded (${err.message}). Serve the app over http(s), not file://.`; return; }
    S.ready = true;
    readHash();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
  window.OH.app = { S, selectDistrict, selectState, selectIndia, setTab, exportData, parseSoilFeatureInfo };
})();
