# Tencent COS connection guide for AI agents

This project can store uploaded references and generated media in Tencent Cloud
Object Storage (COS). Use this guide when an AI agent or local service needs to
connect to the current COS bucket.

## Bucket

- Provider: Tencent Cloud COS
- Bucket: `ccy-canvas-1334659054`
- Region: `ap-beijing`
- Public base URL: `https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com`
- Object key prefix: `ccy-canvas`

## Required environment variables

Set these in the backend runtime environment. Do not commit real secrets.

```env
STORAGE_BACKEND=cos
COS_BUCKET=ccy-canvas-1334659054
COS_REGION=ap-beijing
COS_SECRET_ID=your_tencent_cloud_secret_id
COS_SECRET_KEY=your_tencent_cloud_secret_key
COS_PUBLIC_BASE_URL=https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com
COS_KEY_PREFIX=ccy-canvas
```

For this local workspace, the real values should live in `D:\code\ccy-canvas\.env`.
Agents should read them from environment variables, not from this document.

## How the app uses COS

- Upload endpoint: `POST /api/app/upload`
- Backend storage selector: `STORAGE_BACKEND=cos`
- Storage implementation: `backend/internal/platform/assetstore/store.go`
- Generated media and uploaded references are written under keys like:

```text
ccy-canvas/2026-06/<uuid>.png
ccy-canvas/generated/2026-06/<uuid>.jpg
```

The resulting URL is built from:

```text
{COS_PUBLIC_BASE_URL}/{COS_KEY_PREFIX}/...
```

## Quick validation

After setting env vars and starting the backend, upload one image from the app.
Then check that the returned URL is publicly reachable:

```powershell
curl.exe -I "https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com/ccy-canvas/<path-from-upload>"
```

Expected response:

```text
HTTP/1.1 200 OK
Content-Type: image/png
Server: tencent-cos
```

## Tencent console locations

- Bucket overview: Object Storage > Bucket list > `ccy-canvas-1334659054`
- File browser: File list, then open the `ccy-canvas/` prefix
- CORS: Security management > Cross-origin access CORS settings
- Access key: User avatar > Access Management > API Keys

## Security notes

- Never paste `COS_SECRET_KEY` into GitHub, docs, screenshots, or chat logs.
- Prefer least-privilege CAM credentials for production.
- Rotate the key if it was shared publicly.
- Public-read bucket URLs are intentional because image providers require
  public `http(s)` reference images.
