// Knotty by Nature: online orders.
// POST /api/order        save an order (customer profile + delivery address + pay method)
// GET  /orders?key=...   Alejandro's private list of orders
// POST /api/status       mark an order paid / delivered / texted (needs the key)
// GET  /api/pending?key= orders not texted yet (the Mac auto-texter sends them)
// Everything else is the static site in dist/.

const KITS = {
  smores: { name: "S'mores night kit", price: 35 },
  dads: { name: "Dad's fire kit", price: 35 },
  hers: { name: "Her cozy night kit", price: 35 },
};
// Stacks: price is delivered (unloaded in the driveway); stacking is an add-on (stack = driveway or by the garage, back = carried to the backyard).
const STACKS = {
  patio: { name: 'Patio Stack (4x4 ft)', price: 149, stack: 20, back: 60 },
  face: { name: 'Face Cord (4x8 ft)', price: 249, stack: 30, back: 125 },
  half: { name: 'Half Cord (4x12 ft)', price: 349, stack: 40, back: 180 },
  full: { name: 'Full Cord (4x24 ft)', price: 649, stack: 80, back: 360 },
};
const PAY = ['Cash App', 'Venmo', 'Zelle', 'Cash on delivery'];

const bundlePrice = n => n * (n >= 10 ? 7 : 8);

// Delivery is drop off only. Fee by distance from 78717 (zone 0..4).
// Kits count as 2 bundles. Zone 4 (over 30 miles) = we text a quote.
// Stacks: free up to 20 miles, $35 for 20 to 30.
const ZONES = ['Within 5 miles', '5 to 10 miles', '10 to 20 miles', '20 to 30 miles', 'Over 30 miles'];
function deliveryFee(item, qty, zone) {
  if (zone === 4) return null;
  if (STACKS[item]) return zone === 3 ? 35 : 0;
  const bundles = item === 'bundles' ? qty : qty * 2;
  if (bundles >= 30 && zone <= 2) return 0;
  return [bundles >= 10 ? 0 : 5, 10, 20, 35][zone];
}

function quote(item, qty, stacked) {
  qty = Math.floor(Number(qty));
  const st = STACKS[item];
  if (st) return stacked === 'back'
    ? { label: st.name + ', stacked in the backyard', qty: 1, total: st.price + st.back }
    : stacked
    ? { label: st.name + ', stacked out front', qty: 1, total: st.price + st.stack }
    : { label: st.name + ', delivered', qty: 1, total: st.price };
  if (item === 'bundles') {
    if (!(qty >= 1 && qty <= 200)) return null;
    return { label: qty + ' firewood bundle' + (qty > 1 ? 's' : ''), qty, total: bundlePrice(qty) };
  }
  const kit = KITS[item];
  if (!kit || !(qty >= 1 && qty <= 10)) return null;
  return { label: kit.name, qty, total: kit.price * qty };
}

const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function saveOrder(req, env, ctx, url) {
  let b;
  try { b = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (b.website) return json({ ok: true, id: 'K0' }); // spam trap

  const q = quote(b.item, b.qty, b.stacked === 'back' ? 'back' : b.stacked === true || b.stacked === 'yes');
  if (!q) return json({ error: 'That order size is not available.' }, 400);

  const name = clean(b.name, 80);
  const phone = clean(b.phone, 30);
  const digits = phone.replace(/\D/g, '');
  const method = b.method === 'delivery' || STACKS[b.item] ? 'delivery' : 'pickup';
  const address = clean(b.address, 200);
  const pay = PAY.includes(b.pay) ? b.pay : null;
  const zone = method === 'delivery' ? Math.max(0, Math.min(4, Math.floor(Number(b.zone)) || 0)) : -1;
  const fee = zone >= 0 ? deliveryFee(b.item, q.qty, zone) : 0;
  const total = q.total + (fee || 0);

  if (!name) return json({ error: 'Please add your name.' }, 400);
  if (digits.length < 10) return json({ error: 'Please add a phone number we can text.' }, 400);
  if (method === 'delivery' && address.length < 6) return json({ error: 'Please add your delivery address.' }, 400);
  if (!pay) return json({ error: 'Please pick how you want to pay.' }, 400);

  const now = new Date();
  const id = 'K' + now.getTime().toString(36).slice(-5).toUpperCase();
  const order = {
    id, created: now.toISOString(),
    item: b.item, label: q.label, qty: q.qty, subtotal: q.total, fee, total,
    zone: zone >= 0 ? ZONES[zone] : '',
    name, phone, email: clean(b.email, 120),
    method, address: method === 'delivery' ? address : '',
    notes: clean(b.notes, 400), when: clean(b.when, 80),
    pay, paid: false, delivered: false, texted: false,
  };
  const okey = 'order:' + now.toISOString() + ':' + id;
  await env.ORDERS.put(okey, JSON.stringify(order));
  // Customer profile, keyed by phone, so repeat customers are easy to spot.
  await env.ORDERS.put('customer:' + digits.slice(-10), JSON.stringify({
    name, phone, email: order.email, address: order.address || undefined, updated: order.created,
  }));
  ctx.waitUntil(notify(env, order, url.origin, okey));
  return json({ ok: true, id, total, fee, label: q.label });
}

// Push alert to Alejandro's phone (ntfy app, subscribed to the secret topic).
// Shows the customer's name, phone, address, time and notes; tap opens the orders page.
// Confirmation text Alejandro sends the customer from his own phone (one tap).
const PAY_HOW = {
  'Cash App': 'Cash App to $mralejandrodavila',
  'Venmo': 'Venmo to @Mr-Alejandro-Davila',
  'Zelle': 'Zelle to 512-945-1209 (it shows Yeanette Davila)',
  'Cash on delivery': 'cash when you get your wood',
};
function smsTo(phone) { return '+1' + String(phone).replace(/\D/g, '').slice(-10); }
function confirmText(o) {
  const first = String(o.name).split(' ')[0];
  const where = o.method === 'delivery' ? `Drop off at ${o.address}` : 'Pickup in 78717 (Avery Ranch / Brushy Creek)';
  const deliv = o.method !== 'delivery' || o.fee === undefined ? '' : o.fee === null ? ' plus delivery (I will text you the price)' : o.fee ? ` (includes $${o.fee} delivery)` : ' (free delivery)';
  return `Hi ${first}, this is Alejandro with Knotty by Nature Firewood. Got your order ${o.id}: ${o.label}, $${o.total}${deliv}. ` +
    `${where}${o.when ? ', ' + o.when : ''}. Payment: ${PAY_HOW[o.pay] || o.pay}${o.paid ? ' (received, thank you!)' : ''}. ` +
    `I'll text you before I head over. Thanks for your order!`;
}
const smsLink = o => `sms:${smsTo(o.phone)}?&body=${encodeURIComponent(confirmText(o))}`;

function alertPayload(env, o, origin) {
  return {
    topic: env.NTFY_TOPIC,
    title: `New order ${o.id}`,
    message: [
      `${o.label} · $${o.total} · pays by ${o.pay}`,
      `${o.name} · ${o.phone}`,
      o.method === 'delivery' ? `Drop off: ${o.address}` + (o.zone ? ` (${o.zone}, ${o.fee === null ? 'quote delivery' : o.fee ? '$' + o.fee + ' delivery' : 'free delivery'})` : '') : 'Pickup in 78717',
      o.when && `When: ${o.when}`,
      o.notes && `Notes: ${o.notes}`,
    ].filter(Boolean).join('\n'),
    tags: ['wood'],
    priority: 4,
    click: env.ADMIN_KEY ? `${origin}/orders?key=${env.ADMIN_KEY}` : origin,
    actions: [{ action: 'view', label: 'Text confirmation', url: smsLink(o), clear: true }],
  };
}

// Push alert to Alejandro's phone (ntfy). Retries, then records whether it went out;
// the Mac auto-texter re-sends any alert that didn't.
async function notify(env, o, origin, key) {
  if (!env.NTFY_TOPIC) return;
  let err = '';
  for (const wait of [0, 2000, 6000]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const r = await fetch('https://ntfy.sh/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alertPayload(env, o, origin)),
      });
      if (r.ok) { err = ''; break; }
      err = `${r.status} ${(await r.text()).slice(0, 200)}`;
    } catch (e) { err = String(e); }
    console.log('ntfy attempt failed', o.id, err);
  }
  const cur = await env.ORDERS.get(key, 'json');
  if (cur) { cur.alerted = !err; if (err) cur.alertError = err; await env.ORDERS.put(key, JSON.stringify(cur)); }
}

async function allOrders(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.ORDERS.list({ prefix: 'order:', cursor });
    for (const k of page.keys) {
      const v = await env.ORDERS.get(k.name, 'json');
      if (v) out.push({ key: k.name, ...v });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.reverse(); // newest first
}

const authed = (url, env) => env.ADMIN_KEY && url.searchParams.get('key') === env.ADMIN_KEY;

async function setStatus(req, env, url) {
  if (!authed(url, env)) return json({ error: 'Not allowed' }, 403);
  const { key, field, value } = await req.json();
  if (!String(key).startsWith('order:') || !['paid', 'delivered', 'texted', 'alerted'].includes(field)) return json({ error: 'Bad request' }, 400);
  const o = await env.ORDERS.get(key, 'json');
  if (!o) return json({ error: 'Not found' }, 404);
  o[field] = !!value;
  await env.ORDERS.put(key, JSON.stringify(o));
  return json({ ok: true });
}

function ordersPage(orders, key) {
  const fmt = d => new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const open = orders.filter(o => !o.delivered);
  const rows = orders.map(o => {
    const map = o.address ? `<a href="https://maps.apple.com/?daddr=${encodeURIComponent(o.address)}" target="_blank">${esc(o.address)}</a>` : '<i>Pickup, 78717</i>';
    const tel = o.phone.replace(/[^\d+]/g, '');
    return `<div class="o${o.delivered ? ' done' : ''}">
<div class="top"><b>${esc(o.id)} · ${esc(o.label)}${o.item !== 'bundles' && o.qty > 1 ? ' x' + o.qty : ''}</b><span class="amt">$${o.total}</span></div>
<div>${esc(o.name)} · <a href="sms:${esc(tel)}">${esc(o.phone)}</a>${o.email ? ' · ' + esc(o.email) : ''}</div>
<div>${map}</div>
${o.when ? `<div>When: ${esc(o.when)}</div>` : ''}${o.notes ? `<div>Notes: ${esc(o.notes)}</div>` : ''}
<div class="meta">${fmt(o.created)} · pays by ${esc(o.pay)}</div>
<a class="txt" href="${esc(smsLink(o))}" data-k="${esc(o.key)}">Text confirmation</a>
<label><input type="checkbox" data-k="${esc(o.key)}" data-f="texted"${o.texted ? ' checked' : ''}> Texted</label>
<label><input type="checkbox" data-k="${esc(o.key)}" data-f="paid"${o.paid ? ' checked' : ''}> Paid</label>
<label><input type="checkbox" data-k="${esc(o.key)}" data-f="delivered"${o.delivered ? ' checked' : ''}> Delivered</label>
</div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Knotty orders</title><style>
body{margin:0;background:#f6efe3;color:#2a1d14;font:16px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:auto;padding:20px}h1{font-family:Georgia,serif;font-weight:500}
.o{background:#fffaf2;border:1px solid #e2d4c0;border-left:5px solid #c8501e;border-radius:12px;padding:14px 16px;margin:0 0 12px}
.o.done{opacity:.55;border-left-color:#9b8b7a}.top{display:flex;justify-content:space-between;gap:8px}
.amt{color:#c8501e;font-weight:700}.meta{color:#6e5a4a;font-size:.9rem;margin:4px 0 6px}label{margin-right:16px}
a{color:#c8501e}.txt{display:inline-block;background:#c8501e;color:#fff;text-decoration:none;font-weight:700;padding:7px 14px;border-radius:999px;margin:0 14px 8px 0}</style></head><body><main>
<h1>Orders</h1><p>${open.length} open · ${orders.length} total</p>${rows || '<p>No orders yet.</p>'}
</main><script>
document.querySelectorAll('a.txt').forEach(a=>a.addEventListener('click',()=>{const c=document.querySelector('input[data-f="texted"][data-k="'+CSS.escape(a.dataset.k)+'"]');if(c&&!c.checked){c.checked=true;c.dispatchEvent(new Event('change'))}}));
document.querySelectorAll('input[data-k]').forEach(c=>c.onchange=async()=>{
 const r=await fetch('/api/status?key=${encodeURIComponent(key)}',{method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({key:c.dataset.k,field:c.dataset.f,value:c.checked})});
 if(!r.ok){alert('Could not save');c.checked=!c.checked}else if(c.dataset.f==='delivered')c.closest('.o').classList.toggle('done',c.checked)});
</script></body></html>`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/googleb723e3638a6129a5.html') // Google Search Console verification (keep)
      return new Response('google-site-verification: googleb723e3638a6129a5.html', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/api/order' && req.method === 'POST') return saveOrder(req, env, ctx, url);
    if (url.pathname === '/api/status' && req.method === 'POST') return setStatus(req, env, url);
    if (url.pathname === '/api/pending') {
      // For the Mac auto-texter: orders from the last 24 hours not texted yet, with the confirmation text
      if (!authed(url, env)) return new Response('Not found', { status: 404 });
      const since = Date.now() - 24 * 3600 * 1000;
      const recent = (await allOrders(env)).filter(o => Date.parse(o.created) > since);
      const list = recent.filter(o => !o.texted && !o.delivered)
        .map(o => ({ key: o.key, id: o.id, to: smsTo(o.phone), text: confirmText(o) }));
      // alerted === false means the site tried and failed (older orders have no flag)
      const alerts = recent.filter(o => o.alerted === false)
        .map(o => ({ key: o.key, id: o.id, payload: alertPayload(env, o, url.origin) }));
      if (url.searchParams.get('v') === '2') return json({ texts: list, alerts });
      return json(list);
    }
    if (url.pathname === '/orders') {
      if (!authed(url, env)) return new Response('Not found', { status: 404 });
      return new Response(ordersPage(await allOrders(env), url.searchParams.get('key')), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(req);
  },
};
