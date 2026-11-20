// Knotty by Nature: online orders.
// POST /api/order        save an order (customer profile + delivery address + pay method)
// GET  /orders?key=...   Alejandro's private list of orders
// POST /api/status       mark an order paid / delivered (needs the key)
// Everything else is the static site in dist/.

const KITS = {
  smores: { name: "S'mores night kit", price: 35 },
  dads: { name: "Dad's fire kit", price: 35 },
  hers: { name: "Her cozy night kit", price: 35 },
};
const PAY = ['Cash App', 'Venmo', 'Zelle', 'Cash on delivery'];

const bundlePrice = n => n * (n >= 10 ? 7 : 8);

function quote(item, qty) {
  qty = Math.floor(Number(qty));
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

  const q = quote(b.item, b.qty);
  if (!q) return json({ error: 'That order size is not available.' }, 400);

  const name = clean(b.name, 80);
  const phone = clean(b.phone, 30);
  const digits = phone.replace(/\D/g, '');
  const method = b.method === 'delivery' ? 'delivery' : 'pickup';
  const address = clean(b.address, 200);
  const pay = PAY.includes(b.pay) ? b.pay : null;

  if (!name) return json({ error: 'Please add your name.' }, 400);
  if (digits.length < 10) return json({ error: 'Please add a phone number we can text.' }, 400);
  if (method === 'delivery' && address.length < 6) return json({ error: 'Please add your delivery address.' }, 400);
  if (!pay) return json({ error: 'Please pick how you want to pay.' }, 400);

  const now = new Date();
  const id = 'K' + now.getTime().toString(36).slice(-5).toUpperCase();
  const order = {
    id, created: now.toISOString(),
    item: b.item, label: q.label, qty: q.qty, total: q.total,
    name, phone, email: clean(b.email, 120),
    method, address: method === 'delivery' ? address : '',
    notes: clean(b.notes, 400), when: clean(b.when, 80),
    pay, paid: false, delivered: false,
  };
  await env.ORDERS.put('order:' + now.toISOString() + ':' + id, JSON.stringify(order));
  // Customer profile, keyed by phone, so repeat customers are easy to spot.
  await env.ORDERS.put('customer:' + digits.slice(-10), JSON.stringify({
    name, phone, email: order.email, address: order.address || undefined, updated: order.created,
  }));
  ctx.waitUntil(notify(env, order, url.origin));
  return json({ ok: true, id, total: q.total, label: q.label });
}

// Push alert to Alejandro's phone (ntfy app, subscribed to the secret topic).
// Shows the customer's name, phone, address, time and notes; tap opens the orders page.
async function notify(env, o, origin) {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch('https://ntfy.sh/' + env.NTFY_TOPIC, {
      method: 'POST',
      body: [
        `${o.label} · $${o.total} · pays by ${o.pay}`,
        `${o.name} · ${o.phone}`,
        o.method === 'delivery' ? `Deliver to: ${o.address}` : 'Pickup in 78717',
        o.when && `When: ${o.when}`,
        o.notes && `Notes: ${o.notes}`,
      ].filter(Boolean).join('\n'),
      headers: {
        Title: `New order ${o.id}`,
        Tags: 'wood',
        Priority: 'high',
        Click: env.ADMIN_KEY ? `${origin}/orders?key=${env.ADMIN_KEY}` : origin,
      },
    });
  } catch {}
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
  if (!String(key).startsWith('order:') || !['paid', 'delivered'].includes(field)) return json({ error: 'Bad request' }, 400);
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
a{color:#c8501e}</style></head><body><main>
<h1>Orders</h1><p>${open.length} open · ${orders.length} total</p>${rows || '<p>No orders yet.</p>'}
</main><script>
document.querySelectorAll('input[data-k]').forEach(c=>c.onchange=async()=>{
 const r=await fetch('/api/status?key=${encodeURIComponent(key)}',{method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({key:c.dataset.k,field:c.dataset.f,value:c.checked})});
 if(!r.ok){alert('Could not save');c.checked=!c.checked}else if(c.dataset.f==='delivered')c.closest('.o').classList.toggle('done',c.checked)});
</script></body></html>`;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/order' && req.method === 'POST') return saveOrder(req, env, ctx, url);
    if (url.pathname === '/api/status' && req.method === 'POST') return setStatus(req, env, url);
    if (url.pathname === '/orders') {
      if (!authed(url, env)) return new Response('Not found', { status: 404 });
      return new Response(ordersPage(await allOrders(env), url.searchParams.get('key')), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(req);
  },
};
