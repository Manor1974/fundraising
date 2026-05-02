# Manor Lanes Fundraiser App

Live basket raffle entry, digital display, and customer lookup for fundraising events at Manor Lanes.

## What it does

| URL | Audience | Purpose |
| --- | --- | --- |
| `/` | Staff | Dashboard of events |
| `/setup` | Staff | Create a new event |
| `/admin/:eventId` | Staff (PIN-locked) | Mobile-first portal for entering winning ticket numbers |
| `/display/:eventId` | OptiSigns screens | 1920×1080 live board with QR code |
| `/raffle/:eventId` | Customers | Branded, searchable list of winning numbers (also "Save as PDF") |
| `/qr/:eventId.png` | n/a | QR code PNG that points to `/raffle/:eventId` |

All clients update in real-time via Server-Sent Events.

## Local development

Requires Node.js 20+.

```bash
npm install
npm start            # http://localhost:3000
```

## Deploying to Kinsta (Sevalla) Application Hosting

1. Push this folder to a Git repository (GitHub/GitLab/Bitbucket).
2. In Kinsta MyKinsta → **Applications** → **Add application** → connect the repo.
3. **Build:** leave default (Buildpack auto-detects Node).
4. **Start command:** `npm start` (already set in `package.json`).
5. **Environment variables:** none required. Optionally set `DATA_DIR` and `UPLOADS_DIR` if you mount persistent storage to non-default paths.
6. **Persistent storage** (required so your data survives restarts):
   - Mount path: `/app/data` — size as needed (1 GB is plenty)
   - Mount path: `/app/uploads` — size as needed (1 GB)
   - Then set env vars `DATA_DIR=/app/data` and `UPLOADS_DIR=/app/uploads`.
   - Note: persistent storage on Kinsta limits the app to **one running instance**. That is fine for a single fundraiser at a time.
7. Take note of the assigned domain (e.g. `manor-fundraiser-abc123.kinsta.app`) or attach your custom domain.

### Kinsta caveat: 185-second proxy timeout

Kinsta's Cloudflare front sends a 524 error after 185 seconds of idle on long-lived connections. The SSE endpoint already emits a heartbeat comment every 25 seconds to prevent that. No action needed.

## OptiSigns setup

1. Add a new asset of type **Website**.
2. URL: `https://your-domain/display/<eventId>`
3. **Update Interval:** set to **24 hours** or check **"Load only first time (no refresh)"**. Default of 10 min causes a hard reload that wipes the connection.
4. **Do NOT put this asset in a Playlist.** OptiSigns reloads playlist items every time they rotate back, which defeats live updates. Make it a single-asset full-time display, or rotate it manually as needed.
5. The page itself reloads every 4 hours as a defense against Chromium WebView memory leaks on long-running screens. You won't notice — the SSE reconnects automatically.

## Workflow for a fundraiser event

1. **Day before / morning of:** Open `/` on a laptop, click **+ New Event**. Fill in name, organization, date, time, and number of baskets. Upload the org's logo. Submit. PIN = the event date in MMDD (e.g. May 2 → `0502`).
2. **Print the QR code:** open `/display/:eventId` on the laptop and screenshot/print the QR section, OR open `/qr/:eventId.png` directly. Tape printed QR codes around the venue if you want broad reach.
3. **Set up the screens:** point each OptiSigns screen at `/display/:eventId`.
4. **During the event:** open `/admin/:eventId` on a phone, enter the PIN. As each basket is drawn, tap the basket cell, type the winning ticket number, hit Save. Toggle **Picked up** when claimed.
5. **After the event:** customers can keep checking `/raffle/:eventId` and download a PDF list. The event stays in the dashboard until you delete it.

## Multi-staff entry

Multiple phones can be logged into `/admin/:eventId` at once. They all use the same PIN and stay in sync via SSE. If two people edit the same basket, last-write-wins.

## Editing or correcting a number

In the admin portal, tap any basket — even one that's already been entered — to edit, clear, or change pickup status.

## Where to put logos

- **Manor Lanes brand logo:** `public/logos/manor-lanes.png`. Already in place. Used on every page; rendered white on dark navy via CSS filter.
- **Per-event organization logo:** uploaded through the New Event form. Saved to `uploads/`. Shown on the display board (top-right) and the customer list page (top, on a white card next to Manor Lanes).

## Architecture

- **Node 20 + Express** (one process, ~250 lines)
- **better-sqlite3** synchronous SQLite — file lives at `data/fundraiser.db`
- **Server-Sent Events** for realtime push (admin → display + customer pages)
- **qrcode** lib for on-the-fly QR PNG generation
- **multer** for org-logo upload
- Vanilla HTML/CSS/JS — no build step, no React, no bundler

## Files

```
server.js                    - Express app, routes, SSE, DB
package.json
public/
├── index.html / js/index.js     - Dashboard
├── setup.html / js/setup.js     - New event form
├── admin.html / js/admin.js     - PIN-locked entry portal
├── display.html / js/display.js - 1920x1080 OptiSigns board
├── list.html / js/list.js       - Customer-facing search page
├── css/app.css                  - Manor Lanes branded styles
└── logos/manor-lanes.png        - Manor Lanes brand asset
data/                        - SQLite DB (gitignored)
uploads/                     - Org logos uploaded via /setup (gitignored)
```
