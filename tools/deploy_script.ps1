# Publishes apps-script/ to the Sheet's Apps Script project and moves the app's
# web-app deployment to the new version. The URL stays the same, so the app
# doesn't need reconnecting.
#
# Run from the project root:  powershell -File tools/deploy_script.ps1 "what changed"
# Needs: clasp (npm install -g @google/clasp), `clasp login`, and a local
# .clasp.json pointing at the script (gitignored).

param([Parameter(Mandatory = $true)][string]$Description)
$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:Path"

# The app's deployment is the one pinned to a version number (not @HEAD).
# Its ID is part of the private URL, so it's looked up here rather than stored.
$deployments = clasp list-deployments 2>&1 | Out-String
$ids = @([regex]::Matches($deployments, "- (\S+) @\d+") | ForEach-Object { $_.Groups[1].Value })
if ($ids.Count -ne 1) {
    throw "Expected exactly one versioned deployment, found $($ids.Count):`n$deployments"
}

# Never publish a script that could change the human-edited restaurant tab.
python "$PSScriptRoot\check_sheet_writes.py"
if ($LASTEXITCODE -ne 0) { throw "Publish blocked: the script could change the restaurant tab (see above)." }

clasp push --force
if ($LASTEXITCODE -ne 0) { throw "clasp push failed" }

clasp update-deployment $ids[0] --description $Description
if ($LASTEXITCODE -ne 0) { throw "clasp update-deployment failed" }

clasp list-deployments
