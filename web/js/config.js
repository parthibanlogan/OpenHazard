/* OpenHazard India - config.js
 * Single source of truth for every remote service. Each layer records provider, native resolution,
 * licence and citation so the map never shows data without provenance.
 * tools/verify_endpoints.py loads this file through Node, so the probe list cannot drift from the app.
 */
(function (root) {
  'use strict';
  root.OH = root.OH || {};
  // GIBS through WMS: no tile-matrix level to guess; candidate names cover GIBS layer renames (tried in order)
  const GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
  const ISRIC = 'https://maps.isric.org/mapserv?map=/map/';
  const GSW = 'https://storage.googleapis.com/global-surface-water/tiles2021';

  const WORLDCOVER_LEGEND = [
    [10, 'Tree cover', '#006400'], [20, 'Shrubland', '#ffbb22'], [30, 'Grassland', '#ffff4c'], [40, 'Cropland', '#f096ff'],
    [50, 'Built-up', '#fa0000'], [60, 'Bare / sparse vegetation', '#b4b4b4'], [70, 'Snow and ice', '#f0f0f0'],
    [80, 'Permanent water bodies', '#0064c8'], [90, 'Herbaceous wetland', '#0096a0'], [95, 'Mangroves', '#00cf75'], [100, 'Moss and lichen', '#fae6a0'],
  ];

  const SOIL_PROPS = {
    wrb: { map: 'wrb', label: 'Soil class (WRB, most probable)', layer: () => 'MostProbable', unit: 'class', depth: false },
    clay: { map: 'clay', label: 'Clay content', unit: '%', depth: true },
    sand: { map: 'sand', label: 'Sand content', unit: '%', depth: true },
    silt: { map: 'silt', label: 'Silt content', unit: '%', depth: true },
    soc: { map: 'soc', label: 'Soil organic carbon', unit: 'g/kg', depth: true },
    phh2o: { map: 'phh2o', label: 'pH (H2O)', unit: 'pH', depth: true },
    bdod: { map: 'bdod', label: 'Bulk density (fine earth)', unit: 'kg/dm3', depth: true },
    cec: { map: 'cec', label: 'Cation exchange capacity', unit: 'cmol(c)/kg', depth: true },
    nitrogen: { map: 'nitrogen', label: 'Total nitrogen', unit: 'g/kg', depth: true },
  };
  const SOIL_DEPTHS = ['0-5cm', '5-15cm', '15-30cm', '30-60cm', '60-100cm', '100-200cm'];

  const BASEMAPS = {
    osm: { label: 'Streets', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors (ODbL)' } },
    light: { label: 'Light', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', opts: { maxZoom: 20, subdomains: 'abcd', attribution: '&copy; OpenStreetMap contributors &copy; CARTO' } },
    dark: { label: 'Dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opts: { maxZoom: 20, subdomains: 'abcd', attribution: '&copy; OpenStreetMap contributors &copy; CARTO' } },
    imagery: { label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 19, maxNativeZoom: 18, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' } },
    topo: { label: 'Topographic', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', opts: { maxZoom: 17, subdomains: 'abc', attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)' } },
  };

  // kind: 'tile' | 'wms' | 'gibs' | 'dem' (client-side DEM analysis) | 'vector'
  const OVERLAYS = [
    // --- Terrain ---
    { id: 'dem_tint', group: 'Terrain', label: 'Elevation (hypsometric tint)', kind: 'dem', mode: 'tint',
      source: 'Mapzen/Tilezen Terrain Tiles on AWS (SRTM, GMTED2010, ETOPO1 and others), Terrarium encoding', res: '~30-90 m over India', licence: 'Open; attribution required (see Tilezen joerd attribution)', cite: 'Tilezen joerd, https://github.com/tilezen/joerd' },
    { id: 'dem_slope', group: 'Terrain', label: 'Slope (degrees, Horn 1981)', kind: 'dem', mode: 'slope',
      source: 'Computed in your browser from the Terrarium DEM', res: 'Depends on zoom (pixel size shown in legend)', licence: 'As DEM', cite: 'Horn, B.K.P. (1981) Proc. IEEE 69(1):14-47' },
    { id: 'dem_shade', group: 'Terrain', label: 'Hillshade (computed)', kind: 'dem', mode: 'shade',
      source: 'Computed in your browser from the Terrarium DEM (azimuth 315 deg, altitude 45 deg)', res: 'Depends on zoom', licence: 'As DEM', cite: 'Burrough & McDonnell (1998) Principles of GIS' },
    { id: 'dem_flood', group: 'Terrain', label: 'Inundation screening (bathtub)', kind: 'dem', mode: 'flood',
      source: 'Cells at or below the chosen water level, from the Terrarium DEM', res: 'Depends on zoom', licence: 'As DEM', cite: 'Static, connectivity-free screening only; not a hydraulic model' },
    { id: 'esri_hill', group: 'Terrain', label: 'Hillshade (Esri)', kind: 'tile', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 16, attribution: 'Esri World Hillshade' },
      source: 'Esri World Hillshade', res: 'Multi-source', licence: 'Esri terms of use', cite: 'Esri (2024) World Hillshade' },

    // --- Land cover ---
    { id: 'wc2021', group: 'Land cover', exclusive: 'lc', label: 'ESA WorldCover 2021 (10 m)', kind: 'wms', url: 'https://services.terrascope.be/wms/v2', opts: { layers: 'WORLDCOVER_2021_MAP', format: 'image/png', transparent: true, version: '1.3.0', attribution: 'ESA WorldCover 2021 (CC BY 4.0)' },
      legend: WORLDCOVER_LEGEND, source: 'ESA WorldCover v200 via VITO Terrascope', res: '10 m', licence: 'CC BY 4.0', cite: 'Zanaga et al. (2022) ESA WorldCover 10 m 2021 v200, doi:10.5281/zenodo.7254221', featureInfo: true },
    { id: 'wc2020', group: 'Land cover', exclusive: 'lc', label: 'ESA WorldCover 2020 (10 m)', kind: 'wms', url: 'https://services.terrascope.be/wms/v2', opts: { layers: 'WORLDCOVER_2020_MAP', format: 'image/png', transparent: true, version: '1.3.0', attribution: 'ESA WorldCover 2020 (CC BY 4.0)' },
      legend: WORLDCOVER_LEGEND, source: 'ESA WorldCover v100 via VITO Terrascope', res: '10 m', licence: 'CC BY 4.0', cite: 'Zanaga et al. (2021) ESA WorldCover 10 m 2020 v100, doi:10.5281/zenodo.5571936', featureInfo: true },
    { id: 'igbp', group: 'Land cover', exclusive: 'lc', label: 'MODIS IGBP land cover (500 m)', kind: 'gibs', layers: ['MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual'], fixedTime: '2019-01-01',
      source: 'NASA MCD12Q1 via GIBS', res: '500 m (served to zoom 5)', licence: 'NASA open data', cite: 'Friedl & Sulla-Menashe (2019) MCD12Q1 v006, doi:10.5067/MODIS/MCD12Q1.006' },

    // --- Soil ---
    { id: 'soil', group: 'Soil', label: 'SoilGrids 2.0 property', kind: 'soil',
      source: 'ISRIC SoilGrids 2.0 (WMS)', res: '250 m', licence: 'CC BY 4.0', cite: 'Poggio et al. (2021) SOIL 7:217-240, doi:10.5194/soil-7-217-2021' },

    // --- Surface water ---
    { id: 'gsw_occ', group: 'Surface water', exclusive: 'gsw', label: 'Water occurrence 1984-2021', kind: 'tile', url: GSW + '/occurrence/{z}/{x}/{y}.png', opts: { maxNativeZoom: 13, attribution: 'EC JRC/Google GSW' },
      legendGradient: ['#ffffff', '#ffbbbb', '#0000ff'], legendRange: ['0 %', '100 % of observations'], source: 'JRC Global Surface Water v1.4 (Landsat)', res: '30 m', licence: 'Free, attribution required', cite: 'Pekel et al. (2016) Nature 540:418-422, doi:10.1038/nature20584' },
    { id: 'gsw_season', group: 'Surface water', exclusive: 'gsw', label: 'Water seasonality (months/yr)', kind: 'tile', url: GSW + '/seasonality/{z}/{x}/{y}.png', opts: { maxNativeZoom: 13, attribution: 'EC JRC/Google GSW' },
      source: 'JRC Global Surface Water v1.4', res: '30 m', licence: 'Free, attribution required', cite: 'Pekel et al. (2016), doi:10.1038/nature20584' },
    { id: 'gsw_change', group: 'Surface water', exclusive: 'gsw', label: 'Occurrence change 1984-99 vs 2000-21', kind: 'tile', url: GSW + '/change/{z}/{x}/{y}.png', opts: { maxNativeZoom: 13, attribution: 'EC JRC/Google GSW' },
      source: 'JRC Global Surface Water v1.4', res: '30 m', licence: 'Free, attribution required', cite: 'Pekel et al. (2016), doi:10.1038/nature20584' },
    { id: 'gsw_trans', group: 'Surface water', exclusive: 'gsw', label: 'Water transitions (gain/loss classes)', kind: 'tile', url: GSW + '/transitions/{z}/{x}/{y}.png', opts: { maxNativeZoom: 13, attribution: 'EC JRC/Google GSW' },
      source: 'JRC Global Surface Water v1.4', res: '30 m', licence: 'Free, attribution required', cite: 'Pekel et al. (2016), doi:10.1038/nature20584' },

    // --- Satellite (time-enabled) ---
    { id: 'modis_tc', group: 'Satellite', exclusive: 'sat', label: 'MODIS Terra true colour (daily)', kind: 'gibs', layers: ['MODIS_Terra_CorrectedReflectance_TrueColor'], daily: true, jpeg: true,
      source: 'NASA MODIS Terra corrected reflectance via GIBS', res: '250 m', licence: 'NASA open data', cite: 'NASA EOSDIS GIBS / Worldview' },
    { id: 'viirs_tc', group: 'Satellite', exclusive: 'sat', label: 'VIIRS SNPP true colour (daily)', kind: 'gibs', layers: ['VIIRS_SNPP_CorrectedReflectance_TrueColor', 'VIIRS_NOAA20_CorrectedReflectance_TrueColor'], daily: true, jpeg: true,
      source: 'NASA VIIRS SNPP corrected reflectance via GIBS', res: '250 m', licence: 'NASA open data', cite: 'NASA EOSDIS GIBS / Worldview' },
    { id: 'ndvi', group: 'Satellite', exclusive: 'sat', label: 'NDVI (MODIS composite)', kind: 'gibs', layers: ['MODIS_Terra_L3_NDVI_16Day', 'MODIS_Terra_NDVI_8Day', 'MODIS_Terra_L3_NDVI_Monthly'], daily: true,
      source: 'NASA MOD13 NDVI via GIBS', res: '250 m', licence: 'NASA open data', cite: 'Didan (2021) MOD13Q1 v061, doi:10.5067/MODIS/MOD13Q1.061' },
    { id: 'lst', group: 'Satellite', exclusive: 'sat', label: 'Land surface temperature, day', kind: 'gibs', layers: ['MODIS_Terra_L3_Land_Surface_Temp_Daily_Day', 'MODIS_Terra_Land_Surface_Temp_Day'], daily: true,
      source: 'NASA MOD11 LST via GIBS', res: '1 km', licence: 'NASA open data', cite: 'Wan et al. (2015) MOD11A1, doi:10.5067/MODIS/MOD11A1.006' },
    { id: 'imerg', group: 'Satellite', exclusive: 'sat', label: 'Rain rate (GPM IMERG)', kind: 'gibs', layers: ['IMERG_Precipitation_Rate', 'IMERG_Precipitation_Rate_30min'], daily: true,
      source: 'NASA GPM IMERG via GIBS', res: '0.1 deg', licence: 'NASA open data', cite: 'Huffman et al. (2019) GPM IMERG, doi:10.5067/GPM/IMERG/3B-HH/06' },
    { id: 'blackmarble', group: 'Satellite', exclusive: 'sat', label: 'Night lights 2016 (Black Marble)', kind: 'gibs', layers: ['VIIRS_Black_Marble', 'BlackMarble_2016'], fixedTime: '2016-01-01',
      source: 'NASA VIIRS Black Marble annual composite via GIBS', res: '500 m', licence: 'NASA open data', cite: 'Roman et al. (2018) Remote Sens. Environ. 210:113-143' },

    // --- Live hazards (vector) ---
    { id: 'quakes', group: 'Live hazards', label: 'Earthquakes M2.5+, last 30 days', kind: 'vector', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson',
      source: 'USGS ANSS ComCat real-time feed', res: 'Event catalogue', licence: 'US public domain', cite: 'U.S. Geological Survey Earthquake Hazards Program' },
    { id: 'eonet', group: 'Live hazards', label: 'Open natural events (NASA EONET)', kind: 'vector', url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&bbox=60,40,100,0&limit=200',
      source: 'NASA Earth Observatory Natural Event Tracker v3', res: 'Event catalogue', licence: 'NASA open data', cite: 'NASA EONET v3' },
  ];

  const API = {
    elevation: 'https://api.open-meteo.com/v1/elevation',
    forecast: 'https://api.open-meteo.com/v1/forecast',
    archive: 'https://archive-api.open-meteo.com/v1/archive',
    air: 'https://air-quality-api.open-meteo.com/v1/air-quality',
    flood: 'https://flood-api.open-meteo.com/v1/flood',
    soilProps: 'https://rest.isric.org/soilgrids/v2.0/properties/query',
    soilClass: 'https://rest.isric.org/soilgrids/v2.0/classification/query',
    fdsn: 'https://earthquake.usgs.gov/fdsnws/event/1/query',
    eonet: 'https://eonet.gsfc.nasa.gov/api/v3/events',
    terrarium: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  };

  const SOURCES = [
    ['District and State boundaries', 'Local Government Directory (MoPR) via ramSeraph/indian_admin_boundaries and yashveeeeeeer/india-geodata (commit e4d7768), simplified TopoJSON', 'CC0 1.0'],
    ['Elevation sample (terrain statistics)', 'Copernicus DEM GLO-90 (2021 release), doi:10.5270/ESA-c5d3d65, via Open-Meteo Elevation API', 'Copernicus DEM licence; Open-Meteo CC BY 4.0'],
    ['Open-Meteo APIs', 'Zippenfenig, P. (2023) Open-Meteo.com Weather API, doi:10.5281/ZENODO.7970649', 'CC BY 4.0 (non-commercial free tier)'],
    ['Climate 1981-present', 'ECMWF ERA5 reanalysis (0.25 deg), doi:10.24381/cds.adbb2d47, via Open-Meteo Historical API; Hersbach et al. (2020) QJRMS 146:1999-2049', 'Copernicus licence; Open-Meteo CC BY 4.0'],
    ['Weather forecast', 'Open-Meteo best-match NWP (ECMWF IFS, NCEP GFS, others)', 'CC BY 4.0'],
    ['Air quality', 'CAMS global atmospheric composition forecast via Open-Meteo Air Quality API', 'Copernicus licence; CC BY 4.0'],
    ['River discharge', 'GloFAS v4 (CEMS) reanalysis and forecast via Open-Meteo Flood API; Harrigan et al. (2020) ESSD 12:2043-2060', 'Copernicus licence; CC BY 4.0'],
    ['Soil profiles', 'ISRIC SoilGrids 2.0 REST API, falling back to the SoilGrids WMS (GetFeatureInfo) when the beta REST API is paused; Poggio et al. (2021) SOIL 7:217-240', 'CC BY 4.0'],
    ['Earthquakes', 'USGS ANSS Comprehensive Catalog (FDSN event web service and real-time feed)', 'Public domain'],
    ['Natural events', 'NASA EONET v3', 'NASA open data'],
  ];

  root.OH.config = { OVERLAYS, BASEMAPS, API, GIBS, ISRIC, SOIL_PROPS, SOIL_DEPTHS, WORLDCOVER_LEGEND, SOURCES, VERSION: '5.1.0' };
})(typeof self !== 'undefined' ? self : this);
