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
