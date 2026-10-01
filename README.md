# Nearby Eats

A personal web app: a restaurant shortlist, sorted by walking and transit time from your current location.

Live at https://abhijit340.github.io/restaurant-shortlist/. It's hosted on GitHub Pages, so every push to `main` updates it within about a minute.

The Sheet's script (`apps-script/`) is published with `powershell -File tools/deploy_script.ps1 "what changed"`. That uses [clasp](https://github.com/google/clasp) and a local, gitignored `.clasp.json`, and it keeps the web-app URL unchanged.

No secrets or restaurant data live in this repo. Those stay in a private Google Sheet and its Apps Script.
