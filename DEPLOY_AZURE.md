# Deploy to Azure App Service (Linux) — Zip Deploy

## 1. Create the App Service (one-time)

```powershell
$RG       = "lockbox-rg"
$LOC      = "eastus"
$PLAN     = "lockbox-plan"
$APP      = "lockbox-bot-<unique-suffix>"

az group create -n $RG -l $LOC

az appservice plan create `
  -g $RG -n $PLAN `
  --is-linux --sku B1

az webapp create `
  -g $RG -p $PLAN -n $APP `
  --runtime "NODE:20-lts"
```

## 2. Configure app settings

```powershell
az webapp config appsettings set -g $RG -n $APP --settings `
  AZURE_OPENAI_ENDPOINT="https://<resource>.openai.azure.com" `
  AZURE_OPENAI_API_KEY="<key>" `
  AZURE_OPENAI_API_VERSION="2024-02-01" `
  AZURE_DEPLOYMENT="gpt-4o-mini" `
  SECRET_KEY="<long-random-string>" `
  SCM_DO_BUILD_DURING_DEPLOYMENT="true" `
  WEBSITE_NODE_DEFAULT_VERSION="~20" `
  NODE_ENV="production"

# Startup command (uses package.json "start"):
az webapp config set -g $RG -n $APP --startup-file "node server.js"

# Pin to a single instance so the in-memory conversation store works.
az webapp scale -g $RG -n $APP --instance-count 1
```

## 3. Build the zip

From `D:\Agent\Node\bot`, exclude local-only files:

```powershell
$exclude = @("node_modules","__pycache__","data.xlsx","bash.exe.stackdump",".env","app.py","requirements.txt","sql","*.html.bak")
Compress-Archive -Path (Get-ChildItem -Force | Where-Object { $exclude -notcontains $_.Name }) `
  -DestinationPath bot.zip -Force
```

`templates/index.html` MUST be in the zip. The non-template HTML preview files (`card-*.html`, `lockbox_questionnaire.html`, `mail-card.html`, `preview-*.html`) can be excluded — they aren't served by Express.

## 4. Deploy

```powershell
az webapp deploy -g $RG -n $APP --src-path bot.zip --type zip
```

Or the older command (works the same):

```powershell
az webapp deployment source config-zip -g $RG -n $APP --src bot.zip
```

Oryx will run `npm install` on the server because `SCM_DO_BUILD_DURING_DEPLOYMENT=true`.

## 5. Verify

```powershell
Start-Process "https://$APP.azurewebsites.net/"
```

- Open the page; you should see the chat UI.
- Send a message — SSE should stream tokens (no buffering).
- Click **Export JSON** — file should download.
- Click **Submit** — `data.xlsx` is appended at `/home/site/wwwroot/data.xlsx`.

## Logs

```powershell
az webapp log tail -g $RG -n $APP
```

## Follow-ups

- **Scale-out**: the in-memory `conversations` Map breaks with >1 instance. Add `connect-redis` + Azure Cache for Redis before enabling autoscale.
- **data.xlsx**: lives in App Service file storage — fine for low volume; move to Azure Blob or a database for higher throughput.
- **Secrets**: prefer Key Vault references for `AZURE_OPENAI_API_KEY` and `SECRET_KEY`.
