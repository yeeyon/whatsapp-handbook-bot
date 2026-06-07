# Deploy to Render

Repo: https://github.com/yeeyon/whatsapp-handbook-bot

## 1. Open Blueprint (in your logged-in Chrome)

https://dashboard.render.com/blueprint/new?repo=https://github.com/yeeyon/whatsapp-handbook-bot

## 2. Connect GitHub if prompted

Allow Render to access `yeeyon/whatsapp-handbook-bot`.

## 3. Fill secret env vars before Apply

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Your Neon pooled connection string |
| `AWS_BEARER_TOKEN_BEDROCK` | Your Bedrock bearer token |

All other vars are pre-filled in `render.yaml`.

## 4. Click Apply

Render will create:
- Web service `whatsapp-handbook-bot` (Singapore, starter plan)
- 1GB persistent disk at `/opt/render/project/src/data/auth` for WhatsApp session

## 5. After deploy

- Open `https://<your-service>.onrender.com`
- Scan QR code to link WhatsApp
- Handbook data is already in Neon (124 chunks)

## Notes

- WhatsApp auth survives redeploys via persistent disk
- Re-scan QR only if you clear the disk or logout
- `npm run ingest` is not run on Render; handbook was ingested locally into Neon
