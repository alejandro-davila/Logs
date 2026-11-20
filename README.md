# Knotty by Nature Firewood Co.

Firewood site: ranch cut Texas post oak from the ranch in Rosebud, TX, sold in 5 log bundles.

- $8 per 5 log bundle, $7 each for 10+
- Pickup in 78717, free delivery within 5 miles on 10+ bundles
- Online orders: checkout dialog posts to `/api/order` (src/worker.js), saved in Cloudflare KV. Private list at `/orders?key=...` (key in `.dev.vars`).

## Files
- `dist/index.html`: the whole site (prices are the constants at the top of the script)
- `dist/woods.jpeg`, `dist/bark.jpeg`: ranch photos (location data removed)
- `src/worker.js`: order API and orders page
- `wrangler.jsonc`: Cloudflare Worker that serves `dist/` and runs the worker

## Deploy
```bash
npx wrangler deploy
```
