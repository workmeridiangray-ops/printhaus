# Print Haus

Live printing-business storefront: product catalog, live price calculator, cart, wishlist, accounts, checkout, quote requests, and an admin dashboard — all client-side (localStorage-based prototype, no real backend/payments yet).

## Structure

- `public/index.html` — the entire single-page app (routing, UI, cart/order/quote logic)
- `public/calc-data.json` — the pricing dataset (225 products, sizes/options/quantity-tier pricing)
- `wrangler.toml` — Cloudflare Workers static-assets config

## Deploy (Cloudflare Workers static assets)

This repo is set up to deploy as a Cloudflare Worker serving static assets.

```bash
npm install -g wrangler
wrangler login          # authenticate with your Cloudflare account
wrangler deploy         # deploys public/ as a static Worker
```

That's it — no build step. `wrangler.toml` points `[assets].directory` at `public/`.

## Local preview

```bash
npx wrangler dev
```

## Notes

- This is a prototype: accounts, cart, orders and the admin dashboard are all stored in the visitor's browser (`localStorage`) — nothing is sent to a real server. See inline comments in `index.html` for what still needs a real backend before launch (payments, auth, admin security, etc).
- Admin dashboard demo password: `PrintAdmin123!` — change or remove before any real use.

## ERPNext integration (`public/erpnext-client.js`)

Quote requests and checkout orders can optionally also be created as real
documents in an ERPNext instance (Quotation and Sales Order doctypes), for
job-order tracking, BOM-based costing, etc. This is **optional and inactive
by default** — with no ERPNext configured, the site behaves exactly as the
plain localStorage prototype described above.

**ERPNext itself does not run on Cloudflare Workers.** It's a full
Frappe-framework app (Python + MariaDB + Redis) that needs its own host —
typically [Frappe Cloud](https://frappecloud.com) (managed, easiest to start
with), a VPS, or Docker. Set that up separately; this repo only talks to it
over its REST API once it's running.

### Setup

1. Stand up ERPNext (e.g. a Frappe Cloud site) and install the ERPNext app.
2. In ERPNext: **Settings → API Access** → create an API Key + Secret for an
   integration user scoped to Create/Read/Write on `Quotation` and
   `Sales Order` (not an Administrator login).
3. In ERPNext, under **Customize Form**, add these custom fields so the
   site's data has somewhere to land:
   - `Quotation`: `custom_department`, `custom_related_order`,
     `custom_product_of_interest`, `custom_message` (all Small Text/Data)
   - `Sales Order`: `custom_phone`, `custom_delivery_address`,
     `custom_order_notes` (Small Text/Data)
4. On the live site, open the browser console once and run:
   ```js
   PFErp.configure({
     baseUrl: 'https://your-site.frappecloud.com',
     apiKey: 'xxxxxxxx',
     apiSecret: 'xxxxxxxx'
   });
   ```
   This is stored in that browser's `localStorage` only (`pf_erp_config`).
   Reload the page — quote submissions and checkout now also create ERPNext
   documents; if either call fails, the local record is still saved so
   nothing is lost.

### Security note (read before going live)

Step 4 puts the ERPNext API key/secret in browser `localStorage`, which is
fine for your own testing but **not safe for a public storefront** — any
visitor's browser could read it. For production, swap the direct calls in
`erpnext-client.js`'s `request()` function for calls to a small server-side
proxy (e.g. a Cloudflare Worker route such as `POST /api/quote`) that holds
the real ERPNext credentials server-side and forwards the request. The
`PFErp.trySubmitQuote` / `trySubmitOrder` functions the rest of the site
calls don't need to change — only what's inside `request()`.

### What's deliberately not automated

ERPNext doesn't ship a dedicated "Job Order" doctype for print-shop
production the way some vertical systems do. The standard ERPNext pattern is
**Sales Order → Work Order** (the latter driven by a BOM), and triggering
that conversion is a workflow you set up inside ERPNext itself (a Frappe
automation or manual review step) — not something this client-side file
should do directly against production data. `erpnext-client.js` creates the
Sales Order; the Work Order / production step is intentionally left to
ERPNext's own tools.
