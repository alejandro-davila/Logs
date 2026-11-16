# Rosebud Post Oak

Firewood site: seasoned Texas post oak from the ranch in Rosebud, TX, sold in 20 log bundles.

- $30 per bundle, 3 for $80
- Pickup in 78717, free delivery within 5 miles on 3+ bundles
- The order box builds a text or email with the order

## Files
- `dist/index.html`: the whole site (prices are the constants at the top of the script)
- `dist/woods.jpeg`, `dist/bark.jpeg`: ranch photos (location data removed)
- `wrangler.jsonc`: Cloudflare Worker that serves `dist/`

## Deploy
```bash
npx wrangler deploy
```
