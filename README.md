# OpenHazard India

District hazard atlas for all 36 States/UTs and 785 LGD districts of India, built only on open, citable data. Static web app (GitHub Pages), installable PWA, and Android/iOS app through Capacitor. No API keys, no server, no simulated values: every number is fetched from a named open service at the moment it is shown, and every export carries its provenance.

## What it does

| Area | Capability |
|---|---|
| Places | State and district selectors, search, GPS "find my district", click-to-select; animated auto-zoom to the selected State or district; spotlight mask, cartographic title block, shareable deep links (`#d=<LGD code>&tab=climate&ov=dem_tint`) |
| Map layers | 5 base maps; DEM computed in the browser (hypsometric tint with district-adaptive stretch, Horn slope, hillshade, bathtub inundation screen); ESA WorldCover 2020/2021, MODIS IGBP; SoilGrids 2.0 (9 properties x 6 depths, WRB class); JRC surface water (occurrence, seasonality, change, transitions); NASA GIBS true colour, NDVI, LST, IMERG with a date picker, Black Marble, served through WMS with fallback layer names so GIBS renames do not break the map; live USGS earthquakes and NASA EONET events; swipe comparison; per-layer source, resolution, licence, citation and health status |
| Map inspector | Tap any point: Copernicus GLO-90 elevation, DEM tile elevation, WorldCover class; "Analyse this point" moves the analysis point (e.g. onto a river) |
| District dossier | Terrain, Soil (REST API with automatic fallback to the SoilGrids map service), Climate (ERA5 1981-present, including humid heat), Weather, Air, Rivers (GloFAS, with snapping to the largest river within about 10 km), Earthquakes, Sources; one-click full-dossier CSV |
| State view | 72-hour wet-bulb, temperature, rain and PM2.5 choropleth for every district; AHP priority ranking with user weights and consistency ratio; CSV export |

## Scientific methods

| Output | Method | Reference |
|---|---|---|
| Analysis point | Pole of inaccessibility of the largest polygon part (always inside the district) | Garcia-Castellanos & Lombardo (2007) |
| Area, perimeter | Spherical polygon area, R = 6 371 008.8 m; haversine | Chamberlain & Duquette (2007) |
| Hypsometry | 100-point interior lattice of Copernicus GLO-90; sample-based hypsometric curve and elevation-relief ratio (not area-weighted) | Strahler (1952); Pike & Wilson (1971) |
| Slope, hillshade | 3x3 Horn finite differences on decoded Terrarium tiles | Horn (1981) |
| Soil texture | USDA texture triangle from SoilGrids sand/silt/clay; 90 % prediction interval shown | Poggio et al. (2021) |
| Trends | Conventional Mann-Kendall test with tie correction and Sen's slope; nominal p-values assume independent annual observations | Kendall (1975); Sen (1968) |
| Drought | SPI-3, SPI-12; gamma fit per calendar month on 1991-2020 (Thom MLE), mixed distribution for zeros; windows crossing missing months are omitted | McKee et al. (1993); Thom (1958); WMO (2012), No. 1090 |
| Climate extremes | TXx, TNn, Rx1day, R20mm, CDD, PRCPTOT, days Tmax >= 40 C | ETCCDI, Zhang et al. (2011) |
| Return levels | Gumbel by L-moments on annual maxima (rain and river discharge) | Hosking (1990) |
| Flood status | GloFAS 30-day ensemble median and wettest member vs. 2/5/20-year levels fitted to the consolidated GloFAS reanalysis 1984-2021 | Harrigan et al. (2020) |
| Humid heat | ERA5 daily maximum wet-bulb: annual maximum (TWx), days >= 28 C, Mann-Kendall trends | Hersbach et al. (2020) |
| Heat stress | Wet-bulb temperature; NWS heat index | Stull (2011); Rothfusz (1990); Vecellio et al. (2022) |
| Air quality | CPCB National AQI breakpoints on CAMS concentrations (24-h, max 8-h for O3/CO) | CPCB (2014) |
| Rain classes | IMD 24-hour intensity classes | IMD |
| Seismicity | Mc by maximum curvature + 0.2; b-value by Aki-Utsu MLE, sigma by Shi & Bolt; Poisson recurrence | Aki (1965); Shi & Bolt (1982); Woessner & Wiemer (2005) |
| Priority ranking | Analytic Hierarchy Process, principal eigenvector, CR = CI / 0.58 | Saaty (1980) |

Selected numerical routines are tested against independent SciPy/NumPy references (`tests/test_analytics.py`), including SPI against `scipy.stats.gamma`, Sen's slope against `scipy.stats.theilslopes`, return levels against `scipy.stats.gumbel_r`, and checks that representative district interior points lie inside their polygons and district areas sum to the official 3 287 263 km2 within 1 %. These checks do not constitute validation of every routine or a substitute for source-data and model review.

## Data and licences

| Data | Provider | Licence |
|---|---|---|
| District and State boundaries | Local Government Directory (MoPR) via ramSeraph/indian_admin_boundaries and yashveeeeeeer/india-geodata, commit `e4d7768` | CC0 1.0 |
| Elevation sample | Copernicus DEM GLO-90 via Open-Meteo | Copernicus DEM licence / CC BY 4.0 |
| DEM tiles | Tilezen/Mapzen Terrain Tiles on AWS (SRTM, GMTED2010, ETOPO1 ...) | open, attribution |
| Climate | ECMWF ERA5 via Open-Meteo Historical API | Copernicus licence / CC BY 4.0 |
| Weather, air quality, rivers | Open-Meteo (NWP blend), CAMS, GloFAS v4 | CC BY 4.0 / Copernicus licence |
| Soil | ISRIC SoilGrids 2.0 (WMS and REST) | CC BY 4.0 |
| Land cover | ESA WorldCover 2020/2021 (Terrascope WMS); MODIS MCD12Q1 (GIBS) | CC BY 4.0; NASA open data |
| Surface water | JRC Global Surface Water v1.4 | free, attribution |
| Satellite imagery | NASA GIBS (MODIS, VIIRS, GPM IMERG, Black Marble) | NASA open data |
| Earthquakes, events | USGS ANSS ComCat; NASA EONET v3 | public domain; NASA open data |
| Base maps | OpenStreetMap, CARTO, Esri, OpenTopoMap | see map attribution |

Respect each provider's fair-use limits. Open-Meteo's free tier is for non-commercial use; commercial deployments need an Open-Meteo API plan.

## Repository layout

```
web/                     the app (deployed as-is)
  index.html  manifest.webmanifest  sw.js  icons/
  css/app.css
  js/config.js           every remote service: URL, resolution, licence, citation
  js/analytics.js        statistics and geophysics (browser + Node)
  js/geo.js              geodesy, point-in-polygon, polylabel, lattice sampling
  js/api.js              fetch with timeout, retry/back-off, TTL cache, offline fallback
  js/dem.js              client-side DEM layer (tint, slope, hillshade, inundation)
  js/app.js              map, selection, layers, dossier, State ranking, export
  vendor/                Leaflet 1.9.4, Chart.js 4.4.1, topojson-client 3.1.0 (pinned, MIT/BSD)
  data/                  LGD TopoJSON, district_index.csv, MANIFEST.json (sha256)
tools/build_boundaries.py   rebuild and validate boundaries from the pinned commit
tools/verify_endpoints.py   probe every service: status, content type, CORS, latency
tests/test_analytics.py     JS routines vs SciPy
tests/smoke_test.py         headless Chromium, desktop and mobile, offline fixtures
.github/workflows/          test + deploy to Pages; weekly service probe
```

## Run locally

```bash
python3 -m http.server 8080 --directory web     # open http://localhost:8080
```

The app must be served over http(s); `file://` blocks the boundary files and the service worker.

## Test

```bash
pip install -r requirements-dev.txt && python -m playwright install chromium
python tests/test_analytics.py        # 14 scientific and geometry checks, including SciPy comparisons
python tests/smoke_test.py --shots shots   # 59 UI checks, desktop + mobile, screenshots in shots/
python tools/verify_endpoints.py      # live probe of 39 remote endpoints incl. GIBS fallback names (needs internet)
python tools/build_boundaries.py      # re-download and re-validate LGD boundaries
```

## Deploy on GitHub Pages

1. Create a repository, push this folder to `main`.
2. Settings, Pages, Build and deployment: Source = GitHub Actions.
3. `.github/workflows/pages.yml` runs both test suites and publishes `web/`. The weekly `endpoints.yml` probe writes a service-health table to the run summary.

## Install on phones

PWA: open the Pages URL in Chrome (Android) or Safari (iOS), then "Install app" / "Add to Home Screen". The shell, boundaries and the last data you viewed work offline; CORS map tiles are cached up to 800 tiles.

Native app (Capacitor 6):

```bash
npm install
npm run android        # needs Android Studio; builds from web/
npm run ios            # needs macOS + Xcode
```

For a Play Store listing without native code, PWABuilder (pwabuilder.com) can wrap the Pages URL as a Trusted Web Activity.

## Service notes (checked November 2026)

- ISRIC states that the SoilGrids REST API is a beta service, limited to 5 calls per minute, and has at times been paused. The Soil tab therefore falls back to SoilGrids WMS GetFeatureInfo automatically; prediction intervals and WRB probabilities are only available through REST.
- Open-Meteo Flood API: ensemble statistics exist only for forecast days; the consolidated GloFAS v4 reanalysis ends in July 2022, later history is archived forecasts. Flood thresholds are therefore fitted to 1984-2021.
- NASA GIBS has renamed several MODIS layers (for example `MODIS_Terra_L3_NDVI_16Day`, `MODIS_Terra_L3_Land_Surface_Temp_Daily_Day`). Each GIBS layer lists candidate names; the app switches to the next one automatically if a name returns no imagery.

## Limits to keep in mind

- Point analyses use the nearest grid cell: ERA5 0.25 deg, CAMS about 40 km, GloFAS about 5 km. They describe the analysis point, not the district average.
- ERA5 underestimates convective extremes; reanalysis trends can include observing-system artefacts.
- Climate trend p-values use the conventional Mann-Kendall test: annual serial correlation and multiple comparisons are not adjusted, so p-values are exploratory, not confirmatory.
- The hypsometric curve uses a regular interior point sample, not area-weighted pixels; its integral is descriptive and is not a calibrated hazard or erosion predictor.
- CAMS is a model, not CPCB station data, and often underestimates urban and winter peaks.
- The inundation layer is a static, connectivity-free screen with metre-scale DEM error.
- The seismic recurrence is a catalogue-based screening indicator, not a probabilistic seismic hazard assessment; consult IS 1893 and NDMA guidance.
- Boundaries are simplified for the web; district areas agree with official figures to within a few percent.

## Changes from v4

v4 generated many parameters from a synthesized baseline and used a mixed-vintage boundary file (760 polygons, 34 unnamed). v5 removes every synthesized value, switches to current LGD boundaries (785 districts, codes included), vendors all libraries, adds the scientific dossier, State ranking, client-side DEM analysis, offline support, tests and CI.

## Licence

Code: MIT (see `LICENSE`). Data remain under their providers' licences listed above.
