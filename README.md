# OpenHazard India v4.0 — All-India 36 States & 783 Districts Spatio-Temporal Multi-Hazard Atlas & Decision System

A self-contained, zero-key scientific web & mobile GIS application covering **all 36 States/UTs and 783 Districts of India**, **62 live open-data parameters**, **9 thematic GIS & satellite layers (DEM, LULC, SoilGrids, NASA GIBS NDVI/LST/IMERG, Coastal SLR)**, **6 synchronized scientific plots**, and an **Analytic Hierarchy Process (AHP / MCDA) Stakeholder Decision Engine**.

## 1. Host on GitHub Pages (Zero Cost)
1. Push this repository to GitHub (`main` branch).
2. In your GitHub repository, open **Settings -> Pages -> Build and deployment** and select **GitHub Actions**.
3. The included `.github/workflows/deploy-pages.yml` workflow automatically publishes your live app.

## 2. Install as a Mobile Progressive Web App (PWA)
- Open the hosted URL in **Chrome (Android)** or **Safari (iOS)** and tap **Add to Home Screen**.
- `manifest.json` and `sw.js` provide standalone full-screen mobile execution and offline resilience.

## 3. Build Native Android (.apk / .aab) or iOS App via Capacitor
- Run `npm install` and then `npm run cap:android` or `npm run cap:ios`.
