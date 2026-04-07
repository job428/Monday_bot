/*
  veg-order-app/server.js (rebuild)
  Reconstructed after accidental overwrite. MySQL-backed.

  IMPORTANT:
  - Keep endpoints and UX compatible with previous iterations:
    - Admin token auth via ?token=ADMIN_TOKEN
    - Mobile-first admin pages (customers/veggies/orders/groups/delivery-times)
    - Customer links: /c/:customerToken, Guest links: /g/:guestToken
    - Orders stored in MySQL (veg_order)
    - Print A6: /admin/order/print/:orderId

  NOTE:
  - This file is designed to be self-contained (no external templates).
*/

const express = require('express');
const helmet = require('helmet');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '400kb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'veg_order_app';
const DB_PASS = process.env.DB_PASS || '';
const DB_NAME = process.env.DB_NAME || 'veg_order';

// --- embedded assets ---
// Keep logo route; if base64 missing, serve 404.
let LOGO_PNG_BASE64 = '';

// --- utils ---
function stableId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function nanoid(len = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function bangkokYmd(d) {
  // format date in Asia/Bangkok to YYYY-MM-DD
  const dt = new Date(d);
  // convert to +07 by adding offset diff
  const utc = dt.getTime() + dt.getTimezoneOffset() * 60000;
  const bkk = new Date(utc + 7 * 3600000);
  const y = bkk.getFullYear();
  const m = String(bkk.getMonth() + 1).padStart(2, '0');
  const day = String(bkk.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function bangkokAddDaysYmd(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return bangkokYmd(d);
}

function redirectAdminTo(res, path, msg) {
  const qs = new URLSearchParams({ token: ADMIN_TOKEN });
  if (msg) qs.set('msg', String(msg));
  res.redirect(`${path}${path.includes('?') ? '&' : '?'}${qs.toString()}`);
}

function requireAdmin(req, res) {
  const t = String(req.query.token || '');
  if (t !== String(ADMIN_TOKEN)) {
    res.status(401).type('html').send('Unauthorized');
    return false;
  }
  return true;
}

let _pool;
async function db() {
  if (_pool) return _pool;
  _pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
  });
  return _pool;
}

// --- data access ---
async function getDeliveryTimes() {
  const p = await db();

  const customers = await getAllCustomers();
  const [partners] = await p.query('SELECT id,name,enabled FROM partners WHERE enabled=1 ORDER BY name ASC');
  const [rows] = await p.query('SELECT id,name,time_hm,days_mask,enabled FROM delivery_times ORDER BY id ASC');
  return rows;
}

async function getAllCustomerGroups() {
  const p = await db();
  const [rows] = await p.query('SELECT id,name FROM customer_groups ORDER BY id ASC');
  return rows;
}

async function getAllCustomers() {
  const p = await db();
  const [rows] = await p.query(
    `SELECT c.token,c.label,c.note,c.enabled,c.group_id,c.use_group_price,c.default_delivery_time_id,
            g.name AS group_name
     FROM customers c
     LEFT JOIN customer_groups g ON g.id=c.group_id
     ORDER BY c.created_at DESC`
  );
  return rows;
}

async function getCustomerByToken(token) {
  const p = await db();
  const [rows] = await p.execute(
    'SELECT token,label,note,enabled,group_id,use_group_price,default_delivery_time_id FROM customers WHERE token=? LIMIT 1',
    [token]
  );
  return rows[0] || null;
}

async function getVeggies() {
  const p = await db();
  const [rows] = await p.query('SELECT id,name,unit,price,enabled,sort_order FROM veggies ORDER BY sort_order ASC, name ASC');
  return rows.map(r => ({ ...r, price: Number(r.price || 0) }));
}

async function getVeggiesForCustomer(customerToken) {
  const p = await db();
  const [rows] = await p.execute(
    `SELECT v.id, v.name, v.unit, v.price AS base_price,
            cvp.price AS customer_price,
            gvp.price AS group_price,
            c.use_group_price,
            v.enabled, v.sort_order
     FROM veggies v
     LEFT JOIN customers c ON c.token = ?
     LEFT JOIN group_veg_prices gvp ON gvp.veg_id = v.id AND gvp.group_id = c.group_id
     LEFT JOIN customer_veg_prices cvp ON cvp.veg_id = v.id AND cvp.customer_token = c.token
     WHERE v.enabled = 1
     ORDER BY v.sort_order ASC, v.name ASC`,
    [customerToken]
  );

  return rows.map(r => {
    const useGroup = Number(r.use_group_price || 0) === 1;
    const groupPrice = r.group_price;
    const customerPrice = r.customer_price;
    const basePrice = r.base_price;
    const finalPrice = (useGroup && groupPrice !== null && groupPrice !== undefined) ? groupPrice
      : (customerPrice !== null && customerPrice !== undefined) ? customerPrice
      : basePrice;
    return {
      id: r.id,
      name: r.name,
      unit: r.unit,
      price: Number(finalPrice || 0),
      enabled: r.enabled,
      sort_order: r.sort_order
    };
  });
}

async function hydrateOrdersWithItems(p, orders) {
  const ids = orders.map(o => o.order_id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [items] = await p.query(
    `SELECT id, order_id, veg_id, name_snapshot, unit_snapshot, price_snapshot, qty
     FROM order_items
     WHERE order_id IN (${placeholders})
     ORDER BY id ASC`,
    ids
  );
  const map = new Map();
  for (const o of orders) map.set(o.order_id, { ...o, items: [] });
  for (const it of items) {
    const o = map.get(it.order_id);
    if (o) o.items.push({
      vegId: it.veg_id,
      name: it.name_snapshot,
      unit: it.unit_snapshot,
      price: Number(it.price_snapshot || 0),
      qty: Number(it.qty || 0)
    });
  }
  return Array.from(map.values());
}

async function getOrders({ limit = 500, status = null, deliveryDate = null } = {}) {
  const p = await db();
  const limitInt = Math.max(1, Math.min(2000, parseInt(limit, 10) || 500));

  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(String(status)); }
  if (deliveryDate) { where.push('delivery_date = ?'); params.push(String(deliveryDate).slice(0, 10)); }

  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const [orders] = await p.execute(
    `SELECT order_id, customer_token, guest_token, guest_label, customer_label, created_at, user_agent, status,
            delivery_date, delivery_time_id, delivery_time_name, delivery_time_hm
     FROM orders
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ${limitInt}`,
    params
  );
  return hydrateOrdersWithItems(p, orders);
}

// --- layouts ---
function adminNav(active) {
  const t = encodeURIComponent(ADMIN_TOKEN);
  const link = (href, label, key) => {
    const is = active === key;
    return `<a href="${href}?token=${t}" class="${is ? 'pill' : 'muted'}" style="text-decoration:none">${label}</a>`;
  };
  return `<div class="actions" style="margin:10px 0;justify-content:center">
    ${link('/admin/orders', 'ออเดอร์', 'orders')}
    ${link('/admin/customers', 'ลูกค้า', 'customers')}
    ${link('/admin/veggies', 'ผัก', 'veggies')}
    ${link('/admin/delivery-times', 'เวลาส่ง', 'delivery')}
    ${link('/admin/cash', 'รายรับรายจ่าย', 'cash')}
    ${link('/admin/partners', 'พาร์ทเนอร์', 'partners')}
  </div>`;
}

function adminLayout({ title, active, msg, body }) {
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="สั่งผัก" />
  <style>
    :root{--card:#e7e7e7;--muted:#666;--ink:#111;--danger:#b00020}
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto;max-width:1200px;margin:18px auto;padding:0 12px;line-height:1.35}
    input,select,textarea{padding:10px 12px;border:1px solid #ddd;border-radius:12px;width:100%;font-size:18px}
    button{padding:10px 12px;border-radius:12px;border:1px solid var(--ink);background:var(--ink);color:#fff;font-weight:700;cursor:pointer;font-size:15px}
    button.secondary{background:#fff;color:var(--ink)}
    button.danger{background:var(--danger);border-color:var(--danger)}
    table{width:100%;border-collapse:collapse}
    th,td{border-bottom:1px solid #eee;padding:10px;vertical-align:top;text-align:left}
    th{background:#fafafa;position:sticky;top:0}
    code{background:#f2f2f2;padding:2px 6px;border-radius:8px;word-break:break-all}
    .muted{color:var(--muted);font-size:12px}
    .card{border:1px solid var(--card);border-radius:14px;padding:12px 14px;margin:12px 0}
    .pill{display:inline-block;padding:4px 10px;border-radius:999px;background:#111;color:#fff;font-size:12px}
    .row{display:grid;grid-template-columns: 1fr 1fr; gap:12px}
    .row3{display:grid;grid-template-columns: 1fr 1fr 1fr; gap:12px}
    .actions{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
    .backbtn{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;border:1px solid #ddd;background:#fff;color:#111;font-weight:900;text-decoration:none}
    .seg{display:flex;justify-content:center;gap:10px;margin:10px 0}

    /* Segmented control (Today/Tomorrow) */
    .segSwitch{position:relative;display:flex;align-items:center;justify-content:space-between;gap:0; width:min(320px, 100%); background:#e6e6e6; border:1px solid #d0d0d0; border-radius:999px; padding:4px; overflow:hidden;}
    .segKnob{position:absolute; left:4px; top:4px; bottom:4px; width:calc(50% - 4px); background:#fff; border-radius:999px; box-shadow:0 2px 8px rgba(0,0,0,.12); transform:translateX(var(--knob-x,0px)); transition:transform 160ms ease;}
    .segSwitch.dragging .segKnob{transition:none;}
    .segBtn{position:relative; z-index:1; flex:1; text-align:center; padding:10px 12px; border-radius:999px; font-weight:900; color:#111;}
    .segBtn.on{background:transparent; box-shadow:none;}

    /* legacy toggle (kept in case used elsewhere) */
    .toggle{position:relative;width:74px;height:36px;border-radius:999px;background:#ddd;border:1px solid #cfcfcf;cursor:pointer;display:inline-flex;align-items:center;padding:4px;}
    .toggle .knob{width:28px;height:28px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.18);transform:translateX(0);transition:transform 160ms ease;}
    .toggle.on{background:#111;border-color:#111;}
    .toggle.on .knob{transform:translateX(34px)}
  </style>
</head>
<body>
  <div class="actions" style="justify-content:space-between;align-items:center;margin:6px 0">
    <button class="backbtn" type="button" onclick="(history.length>1)?history.back():location.href='/'">←</button>
    <h1 style="margin:0;flex:1;text-align:center">${escapeHtml(title)}</h1>
    <div style="width:44px"></div>
  </div>
  ${adminNav(active)}
  ${msg ? `<div class="card"><b>${escapeHtml(msg)}</b></div>` : ''}
  ${body}

  <script>
    // Pull-to-refresh (มือถือ: ลากลงเพื่อรีเฟรชเหมือน YouTube)
    (function(){
      var THRESH = 70;
      var startY = null;
      var pulling = false;
      var armed = false;
      var bar = null;
      function ensureBar(){
        if (bar) return bar;
        bar = document.createElement('div');
        bar.id='ptrBar';
        bar.style.position='fixed';bar.style.left='0';bar.style.right='0';bar.style.top='0';
        bar.style.height='48px';bar.style.display='flex';bar.style.alignItems='center';bar.style.justifyContent='center';
        bar.style.background='#111';bar.style.color='#fff';bar.style.fontWeight='800';
        bar.style.transform='translateY(-52px)';bar.style.transition='transform 160ms ease';
        bar.style.zIndex='9999';
        bar.textContent='ลากลงเพื่อรีเฟรช';
        document.body.appendChild(bar);
        return bar;
      }
      function setBar(y){
        var b=ensureBar();
        var t=Math.max(-52, Math.min(0, -52 + y));
        b.style.transform='translateY('+t+'px)';
        if (y>=THRESH){ b.textContent='ปล่อยเพื่อรีเฟรช'; armed=true; }
        else { b.textContent='ลากลงเพื่อรีเฟรช'; armed=false; }
      }
      function hideBar(){ if(bar) bar.style.transform='translateY(-52px)'; }
      document.addEventListener('touchstart', function(e){
        if (e.touches && e.touches.length===1 && (window.scrollY||document.documentElement.scrollTop||0)<=0){
          startY=e.touches[0].clientY; pulling=true;
        } else { startY=null; pulling=false; }
      }, {passive:true});
      document.addEventListener('touchmove', function(e){
        if(!pulling||startY==null) return;
        var y=e.touches[0].clientY-startY;
        if(y<=0) return;
        if(e.cancelable) e.preventDefault();
        setBar(Math.min(140,y));
      }, {passive:false});
      document.addEventListener('touchend', function(){
        if(!pulling) return;
        pulling=false;
        if(armed){ if(bar) bar.textContent='กำลังรีเฟรช...'; setTimeout(function(){location.reload();},150); }
        else hideBar();
        startY=null;
      }, {passive:true});
    })();
  </script>
</body>
</html>`;
}

// --- routes ---
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(JSON.stringify({
    name: 'สั่งผัก',
    short_name: 'สั่งผัก',
    start_url: `/admin?token=${ADMIN_TOKEN}`,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#111111',
    icons: []
  }));
});

app.get('/assets/logo.png', (req, res) => {
  if (!LOGO_PNG_BASE64) return res.status(404).end();
  res.type('image/png').send(Buffer.from(LOGO_PNG_BASE64, 'base64'));
});

// admin landing -> orders
app.get('/admin', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const t = encodeURIComponent(ADMIN_TOKEN);
  return res.redirect(`/admin/orders?token=${t}`);
});

// --- admin orders ---
app.get('/admin/orders', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const status = (req.query.status || '').toString().trim();
  const filterStatus = (status === 'new' || status === 'canceled' || status === 'sent') ? status : 'new';

  // default date tab = today (no URL redirect; purely server-side default)
  const dateTab = ((req.query.date || '').toString().trim() || 'today');
  const dateFilter = (dateTab === 'today') ? bangkokYmd(new Date()) : (dateTab === 'tomorrow') ? bangkokAddDaysYmd(1) : bangkokYmd(new Date());

  const orders = await getOrders({ limit: 500, status: filterStatus, deliveryDate: dateFilter });

  if (req.query.partial === '1' || req.get('x-partial') === '1') {
    const partialHtml = orders.map(o => {
      const rawLabel = String(o.customer_label || o.guest_label || 'ลูกค้า');
      const label = escapeHtml(rawLabel.replace(/\s+\d{1,2}\/\d{1,2}\/\d{4}.*/,'').trim());
      const items = (o.items || []);
      const total = items.reduce((s,it)=> s + (Number(it.price||0)*Number(it.qty||0)), 0);
      const st = String(o.status || 'new');
      const stLabel = (st==='new'?'ใหม่':st==='sent'?'ส่งแล้ว':st==='canceled'?'ยกเลิก':st);
      const stColor = (st==='new'?'#666':st==='sent'?'#6f42c1':st==='canceled'?'#b00020':'#666');
      const dYmd = o.delivery_date ? String(o.delivery_date).slice(0,10) : '';
      const today = bangkokYmd(new Date());
      const dLabel = (dYmd===today)?'วันนี้':(dYmd===bangkokAddDaysYmd(1))?'วันพรุ่งนี้':'';
      const deliveryShort = (o.delivery_time_name && dLabel) ? `${escapeHtml(o.delivery_time_name)} ${escapeHtml(dLabel)}` : '';

      return `<div class="card" style="margin:12px 0">
        <div class="actions" style="justify-content:space-between;align-items:flex-start">
          <div>
            <div class="actions" style="align-items:center">
              <div><b>${label}</b></div>
              <span class="pill" style="background:${stColor};color:#fff">${stLabel}</span>
            </div>
            <div class="muted">${deliveryShort || ''}</div>
          </div>
          <div style="text-align:right">
            <div class="muted">ยอดรวม</div>
            <div style="font-size:18px;font-weight:800">${escapeHtml(total.toLocaleString('th-TH'))}</div>
          </div>
        </div>
      </div>`;
    }).join('');
    return res.type('text/html').send(partialHtml);
  }

  const t = encodeURIComponent(ADMIN_TOKEN);

  function tabToggle(label, key, on) {
    const href = `/admin/orders?token=${t}&status=${encodeURIComponent(filterStatus)}&date=${encodeURIComponent(key)}`;
    return `<a href="${href}" class="toggle ${on?'on':''}" style="text-decoration:none" aria-label="${escapeHtml(label)}"><span class="knob"></span></a>`;
  }

  const body = `
  <div class="card">
    <h2 style="margin:0 0 8px">จัดการออเดอร์</h2>
    <div class="muted">รายการออเดอร์ล่าสุด</div>

    <div class="seg" style="justify-content:center">
      <div class="segSwitch" id="dateSwitch" role="group" aria-label="แสดงรายการตามวัน">
        <div class="segKnob" aria-hidden="true"></div>
        <a href="/admin/orders?token=${t}&status=${encodeURIComponent(filterStatus)}&date=today" class="segBtn ${dateTab==='today' ? 'on' : ''}" style="text-decoration:none">วันนี้</a>
        <a href="/admin/orders?token=${t}&status=${encodeURIComponent(filterStatus)}&date=tomorrow" class="segBtn ${dateTab==='tomorrow' ? 'on' : ''}" style="text-decoration:none">พรุ่งนี้</a>
      </div>
    </div>

    <script>
      // Swipe left/right to switch Today/Tomorrow (knob follows finger)
      (function(){
        var sw = document.getElementById('dateSwitch');
        if (!sw) return;
        var active = ${JSON.stringify((dateTab==='tomorrow') ? 'tomorrow' : 'today')};
        var base = '/admin/orders?token=${t}&status=${encodeURIComponent(filterStatus)}';

        function baseX(which){
          var w = sw.clientWidth - 8; // padding left+right
          var a = which || active;
          return (a === 'tomorrow') ? (w/2) : 0;
        }

        function setX(px){
          sw.style.setProperty('--knob-x', px + 'px');
        }

        function go(next){
          // navigate immediately when selection changes
          if (next === active) return;
          location.href = base + '&date=' + encodeURIComponent(next);
        }

        // init position
        setX(baseX());

        var x0=null, y0=null, dragging=false;
        var startActive = active;

        // capture on the switch itself to avoid missing events
        sw.addEventListener('touchstart', function(e){
          if (!e.touches || e.touches.length !== 1) return;
          var t=e.touches[0];
          x0=t.clientX; y0=t.clientY;
          dragging=true;
          startActive = active;
          sw.classList.add('dragging');
        }, {passive:true});

        sw.addEventListener('touchmove', function(e){
          if (!dragging || x0==null||y0==null) return;
          var t=e.touches[0];
          var dx=t.clientX-x0;
          var dy=t.clientY-y0;
          if (Math.abs(dx) <= 6 || Math.abs(dx) < Math.abs(dy)) return;
          if (e.cancelable) e.preventDefault();

          var w = sw.clientWidth - 8;
          var half = w/2;
          var bx = baseX(startActive);
          var x = bx + dx;
          x = Math.max(0, Math.min(half, x));
          setX(x);
        }, {passive:false});

        sw.addEventListener('touchend', function(e){
          if (!dragging) return;
          dragging=false;
          sw.classList.remove('dragging');

          var t=(e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : null;
          if (!t) { x0=y0=null; setX(baseX(startActive)); return; }

          var dx=t.clientX-x0;
          var dy=t.clientY-y0;
          x0=y0=null;

          var w = sw.clientWidth - 8;
          var half = w/2;
          var bx = baseX(startActive);
          var x = Math.max(0, Math.min(half, bx + dx));
          var next = (x >= half/2) ? 'tomorrow' : 'today';

          // snap knob
          active = startActive; // keep current until navigate
          setX(baseX(next));

          // if selection changed, navigate immediately (no extra tap)
          if (next !== startActive && Math.abs(dx) > Math.abs(dy)) {
            setTimeout(function(){ go(next); }, 30);
          } else {
            // snap back
            setX(baseX(startActive));
          }
        }, {passive:true});

        sw.addEventListener('touchcancel', function(){
          dragging=false;
          sw.classList.remove('dragging');
          x0=y0=null;
          setX(baseX(startActive));
        }, {passive:true});
      })();
    </script>

    <div class="actions" style="margin-top:10px">
      <a href="/admin/orders?token=${t}&status=new${dateTab?`&date=${encodeURIComponent(dateTab)}`:''}" class="${filterStatus==='new' ? 'pill' : 'muted'}" style="text-decoration:none">ออเดอร์ใหม่</a>
      <a href="/admin/orders?token=${t}&status=sent${dateTab?`&date=${encodeURIComponent(dateTab)}`:''}" class="${filterStatus==='sent' ? 'pill' : 'muted'}" style="text-decoration:none">จัดส่งแล้ว</a>
      <a href="/admin/orders?token=${t}&status=canceled${dateTab?`&date=${encodeURIComponent(dateTab)}`:''}" class="${filterStatus==='canceled' ? 'pill' : 'muted'}" style="text-decoration:none">ยกเลิก</a>
    </div>
  </div>

  <div id="ordersRoot">
    ${orders.map(o => {
      const rawLabel = String(o.customer_label || o.guest_label || 'ลูกค้า');
      const label = escapeHtml(rawLabel.replace(/\s+\d{1,2}\/\d{1,2}\/\d{4}.*/,'').trim());
      const items = (o.items||[]);
      const total = items.reduce((s,it)=> s + (Number(it.price||0)*Number(it.qty||0)), 0);
      const st = String(o.status || 'new');
      const stLabel = (st==='new'?'ใหม่':st==='sent'?'ส่งแล้ว':st==='canceled'?'ยกเลิก':st);
      const stColor = (st==='new'?'#666':st==='sent'?'#6f42c1':st==='canceled'?'#b00020':'#666');
      const dYmd = o.delivery_date ? String(o.delivery_date).slice(0,10) : '';
      const today = bangkokYmd(new Date());
      const dLabel = (dYmd===today)?'วันนี้':(dYmd===bangkokAddDaysYmd(1))?'วันพรุ่งนี้':'';
      const deliveryShort = (o.delivery_time_name && dLabel) ? `${escapeHtml(o.delivery_time_name)} ${escapeHtml(dLabel)}` : '';

      return `<div class="card" style="margin:12px 0">
        <div class="actions" style="justify-content:space-between;align-items:flex-start">
          <div>
            <div class="actions" style="align-items:center">
              <div><b>${label}</b></div>
              <span class="pill" style="background:${stColor};color:#fff">${stLabel}</span>
            </div>
            <div class="muted">${deliveryShort}</div>
          </div>
          <div style="text-align:right">
            <div class="muted">ยอดรวม</div>
            <div style="font-size:18px;font-weight:800">${escapeHtml(total.toLocaleString('th-TH'))}</div>
          </div>
        </div>
        <div style="height:10px"></div>
        <div>
          ${items.map(it => `<div style="padding:8px 0;border-top:1px solid #f0f0f0"><b>${escapeHtml(it.name)}</b> <span class="muted">${escapeHtml(it.unit||'')}</span> <span style="float:right"><b>x${escapeHtml(it.qty)}</b></span></div>`).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>`;

  res.type('html').send(adminLayout({ title: 'ออเดอร์', active: 'orders', msg: req.query.msg ? String(req.query.msg) : '', body }));
});



// --- admin partners (ผู้รับเงิน/ผู้ขายของ) ---
app.get('/admin/partners', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const p = await db();
  const [partners] = await p.query('SELECT id,name,note,enabled,default_receiving_time_id FROM partners ORDER BY id DESC');
  const [deliveryTimes] = await p.query('SELECT id,name,time_hm FROM delivery_times ORDER BY id ASC');

  const deliveryOptions = ['<option value="">(ไม่ตั้งค่า)</option>'].concat(
    deliveryTimes.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}${d.time_hm ? ' ('+escapeHtml(d.time_hm)+')' : ''}</option>`)
  ).join('');

  const msg = req.query.msg ? String(req.query.msg) : '';

  const body = `
  <div class="card">
    <div class="actions" style="justify-content:space-between;align-items:center">
      <div>
        <h2 style="margin:0">จัดการพาร์ทเนอร์</h2>
        <div class="muted">สำหรับรายจ่าย: จ่ายให้ใคร / เวลารับของเริ่มต้น</div>
      </div>
      <button type="button" id="btnNewPartner">+ เพิ่มพาร์ทเนอร์</button>
    </div>

    <div style="height:12px"></div>

    <div class="card" style="padding:0">
      ${partners.map(r => {
        const badge = r.enabled ? '' : '<span class="pill" style="background:#f2f2f2;color:#111">off</span>';
        const dt = deliveryTimes.find(x => Number(x.id) === Number(r.default_receiving_time_id||0));
        const dtLabel = dt ? `${escapeHtml(dt.name)}${dt.time_hm ? ' ('+escapeHtml(dt.time_hm)+')' : ''}` : '';
        return `
          <button type="button" class="secondary" style="width:100%;text-align:left;border:none;border-bottom:1px solid #eee;border-radius:0;padding:14px 14px" onclick="openPartnerDetail(${escapeHtml(JSON.stringify(r.id))})">
            <div class="actions" style="justify-content:space-between;align-items:center">
              <div>
                <div><b>${escapeHtml(r.name)}</b> ${badge}</div>
                <div class="muted">${dtLabel || ' '}</div>
              </div>
              <div class="muted">→</div>
            </div>
          </button>
        `;
      }).join('')}
    </div>

    <dialog id="dlgNewPartner" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <form method="post" action="/admin/partner/create?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">เพิ่มพาร์ทเนอร์</h3>
          <button type="button" class="secondary" id="btnCloseNewPartner">ปิด</button>
        </div>

        <div style="height:12px"></div>
        <div class="row">
          <div>
            <div class="muted">ชื่อ (ห้ามซ้ำ)</div>
            <input name="name" required />
          </div>
          <div>
            <div class="muted">เปิดใช้งาน</div>
            <select name="enabled"><option value="1" selected>on</option><option value="0">off</option></select>
          </div>
        </div>

        <div style="height:10px"></div>
        <div>
          <div class="muted">เวลารับของเริ่มต้น</div>
          <select name="default_receiving_time_id">${deliveryOptions}</select>
        </div>

        <div style="height:10px"></div>
        <div>
          <div class="muted">หมายเหตุ</div>
          <input name="note" />
        </div>

        <div style="height:14px"></div>
        <div class="actions" style="justify-content:flex-end">
          <button type="button" class="secondary" id="btnCancelNewPartner">ยกเลิก</button>
          <button type="submit">เพิ่ม</button>
        </div>
      </form>
    </dialog>

    <dialog id="dlgPartnerDetail" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <div class="card" style="border:none;margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0" id="partnerTitle">รายละเอียด</h3>
          <button type="button" class="secondary" id="btnClosePartnerDetail">ปิด</button>
        </div>

        <form method="post" action="/admin/partner/update?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
          <input type="hidden" name="id" id="partner_id" />

          <div style="height:12px"></div>
          <div>
            <div class="muted">ชื่อ (ห้ามซ้ำ)</div>
            <input name="name" id="partner_name" required />
          </div>
          <div style="height:10px"></div>
          <div>
            <div class="muted">เวลารับของเริ่มต้น</div>
            <select name="default_receiving_time_id" id="partner_dt">${deliveryOptions}</select>
          </div>
          <div style="height:10px"></div>
          <div>
            <div class="muted">เปิดใช้งาน</div>
            <select name="enabled" id="partner_enabled"><option value="1">on</option><option value="0">off</option></select>
          </div>
          <div style="height:10px"></div>
          <div>
            <div class="muted">หมายเหตุ</div>
            <input name="note" id="partner_note" />
          </div>

          <div style="height:14px"></div>
          <div class="actions" style="justify-content:flex-end">
            <button type="submit">บันทึก</button>
          </div>
        </form>

        <div style="height:10px"></div>
        <form method="post" action="/admin/partner/delete?token=${escapeHtml(ADMIN_TOKEN)}" onsubmit="return confirm('ลบพาร์ทเนอร์นี้?')" style="margin:0">
          <input type="hidden" name="id" id="partner_delete_id" />
          <button type="submit" class="danger">ลบ</button>
        </form>
      </div>
    </dialog>

    <script>
      (function(){
        var rows = ${JSON.stringify(partners).replace(/</g,'\\u003c')};
        var byId = new Map(rows.map(r => [Number(r.id), r]));

        var dlgNew = document.getElementById('dlgNewPartner');
        var btnNew = document.getElementById('btnNewPartner');
        var btnCloseNew = document.getElementById('btnCloseNewPartner');
        var btnCancelNew = document.getElementById('btnCancelNewPartner');

        var dlgD = document.getElementById('dlgPartnerDetail');
        var btnCloseD = document.getElementById('btnClosePartnerDetail');

        var elId = document.getElementById('partner_id');
        var elTitle = document.getElementById('partnerTitle');
        var elName = document.getElementById('partner_name');
        var elNote = document.getElementById('partner_note');
        var elEnabled = document.getElementById('partner_enabled');
        var elDt = document.getElementById('partner_dt');
        var delId = document.getElementById('partner_delete_id');

        function openDlg(d){ if(d && d.showModal) d.showModal(); else if(d) d.setAttribute('open','open'); }
        function closeDlg(d){ if(d && d.close) d.close(); else if(d) d.removeAttribute('open'); }

        if(btnNew) btnNew.addEventListener('click', function(){ openDlg(dlgNew); });
        if(btnCloseNew) btnCloseNew.addEventListener('click', function(){ closeDlg(dlgNew); });
        if(btnCancelNew) btnCancelNew.addEventListener('click', function(){ closeDlg(dlgNew); });

        window.openPartnerDetail = function(id){
          var r = byId.get(Number(id));
          if(!r) return;
          elId.value = r.id;
          delId.value = r.id;
          elTitle.textContent = r.name;
          elName.value = r.name || '';
          elNote.value = r.note || '';
          if (elCustLabel) elCustLabel.value = r.customer_label || '';
          if (elPartnerName) elPartnerName.value = r.partner_name || '';
          elEnabled.value = String(r.enabled ? 1 : 0);
          elDt.value = r.default_receiving_time_id ? String(r.default_receiving_time_id) : '';
          openDlg(dlgD);
        };

        if(btnCloseD) btnCloseD.addEventListener('click', function(){ closeDlg(dlgD); });
      })();
    </script>
  </div>
  `;

  res.type('html').send(adminLayout({ title: 'พาร์ทเนอร์', active: 'partners', msg, body }));
});

app.post('/admin/partner/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, note, enabled, default_receiving_time_id } = req.body || {};
  const nm = String(name||'').trim();
  const nt = String(note||'').trim();
  const en = String(enabled)==='0'?0:1;
  const dt = default_receiving_time_id ? Number(default_receiving_time_id) : null;
  if(!nm) return redirectAdminTo(res, '/admin/partners', 'ชื่อหาย');
  const p = await db();
  try{
    await p.execute('INSERT INTO partners(name,note,enabled,default_receiving_time_id) VALUES (?,?,?,?)', [nm, nt, en, dt]);
  }catch(e){
    console.error(e);
    return redirectAdminTo(res, '/admin/partners', 'ชื่อซ้ำ/เพิ่มไม่สำเร็จ');
  }
  return redirectAdminTo(res, '/admin/partners', 'เพิ่มแล้ว');
});

app.post('/admin/partner/update', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id, name, note, enabled, default_receiving_time_id } = req.body || {};
  const pid = Number(id);
  const nm = String(name||'').trim();
  const nt = String(note||'').trim();
  const en = String(enabled)==='0'?0:1;
  const dt = default_receiving_time_id ? Number(default_receiving_time_id) : null;
  if(!pid) return redirectAdminTo(res, '/admin/partners', 'id หาย');
  if(!nm) return redirectAdminTo(res, '/admin/partners', 'ชื่อหาย');
  const p = await db();
  try{
    await p.execute('UPDATE partners SET name=?, note=?, enabled=?, default_receiving_time_id=? WHERE id=?', [nm, nt, en, dt, pid]);
  }catch(e){
    console.error(e);
    return redirectAdminTo(res, '/admin/partners', 'ชื่อซ้ำ/บันทึกไม่สำเร็จ');
  }
  return redirectAdminTo(res, '/admin/partners', 'บันทึกแล้ว');
});

app.post('/admin/partner/delete', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pid = Number((req.body && req.body.id) || 0);
  if(!pid) return redirectAdminTo(res, '/admin/partners', 'id หาย');
  const p = await db();
  await p.execute('DELETE FROM partners WHERE id=?', [pid]);
  return redirectAdminTo(res, '/admin/partners', 'ลบแล้ว');
});

// --- admin cash (income/expense) ---
// Cash flow: income/expense entries.
// income is linked to customers; expense is linked to partners.

function ym(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

app.get('/admin/cash', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const p = await db();

  const customers = await getAllCustomers();
  const [partners] = await p.query('SELECT id,name,enabled FROM partners WHERE enabled=1 ORDER BY name ASC');

  const today = bangkokYmd(new Date());
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset()*60000;
  const bkk = new Date(utc + 7*3600000);
  const monthStart = `${bkk.getFullYear()}-${String(bkk.getMonth()+1).padStart(2,'0')}-01`;

  const [rows] = await p.execute(
    `SELECT id, type, amount, category, note, entry_date, created_at, customer_token, customer_label, partner_id, partner_name
     FROM cash_entries
     ORDER BY entry_date DESC, id DESC
     LIMIT 500`
  );

  const [[todaySum]] = await p.execute(
    `SELECT
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense
     FROM cash_entries
     WHERE entry_date = ?`,
    [today]
  );

  const [[monthSum]] = await p.execute(
    `SELECT
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense
     FROM cash_entries
     WHERE entry_date >= ?`,
    [monthStart]
  );

  const body = `
  <div class="card">
    <div class="actions" style="justify-content:space-between;align-items:center">
      <div>
        <h2 style="margin:0">รายรับ/รายจ่าย</h2>
        <div class="muted">บันทึกแยกจากออเดอร์</div>
      </div>
      <div class="actions" style="gap:8px">
        <button type="button" id="btnNewIncome" style="background:#0b6;border-color:#0b6">+ เพิ่มรายรับ</button>
        <button type="button" id="btnNewExpense" style="background:#b00020;border-color:#b00020">+ เพิ่มรายจ่าย</button>
      </div>
    </div>

    <div style="height:12px"></div>

    <div class="row">
      <div class="card" style="margin:0">
        <div class="muted">วันนี้ (${escapeHtml(today)})</div>
        <div class="actions" style="justify-content:space-between">
          <div><div class="muted">รายรับ</div><div style="font-weight:900;font-size:18px">${Number(todaySum.income||0).toLocaleString('th-TH')}</div></div>
          <div><div class="muted">รายจ่าย</div><div style="font-weight:900;font-size:18px">${Number(todaySum.expense||0).toLocaleString('th-TH')}</div></div>
          <div><div class="muted">คงเหลือ</div><div style="font-weight:900;font-size:18px">${Number((todaySum.income||0)-(todaySum.expense||0)).toLocaleString('th-TH')}</div></div>
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="muted">เดือนนี้ (ตั้งแต่ ${escapeHtml(monthStart)})</div>
        <div class="actions" style="justify-content:space-between">
          <div><div class="muted">รายรับ</div><div style="font-weight:900;font-size:18px">${Number(monthSum.income||0).toLocaleString('th-TH')}</div></div>
          <div><div class="muted">รายจ่าย</div><div style="font-weight:900;font-size:18px">${Number(monthSum.expense||0).toLocaleString('th-TH')}</div></div>
          <div><div class="muted">คงเหลือ</div><div style="font-weight:900;font-size:18px">${Number((monthSum.income||0)-(monthSum.expense||0)).toLocaleString('th-TH')}</div></div>
        </div>
      </div>
    </div>

    <dialog id="dlgNewCash" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <form method="post" action="/admin/cash/create?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">เพิ่มรายการ</h3>
          <button type="button" class="secondary" id="btnCloseNewCash">ปิด</button>
        </div>

        <div style="height:12px"></div>
        <input type="hidden" name="type" id="new_cash_type" value="income" />
        <div class="row3">
          <div>
            <div class="muted">ประเภท</div>
            <div id="new_cash_type_label" style="font-weight:900">รายรับ</div>
          </div>
          <div>
            <div class="muted">จำนวนเงิน</div>
            <input name="amount" type="number" step="0.01" required />
          </div>
          <div>
            <div class="muted">วันที่</div>
            <input name="entry_date" type="date" value="${escapeHtml(today)}" required />
          </div>
        </div>
        <div style="height:10px"></div>
        <div class="row">
          <div id="wrap_new_customer">
            <div class="muted">รับจาก (ลูกค้า)</div><input name="customer_label" id="new_cash_customer_label" placeholder="ชื่อลูกค้า (ถ้าไม่ได้เลือกจากลิสต์)" />
          </div>
          <div>
            <div class="muted">หมายเหตุ</div>
            <input name="note" placeholder="เช่น ซื้อหมูบด" />
          </div>
          <div id="wrap_new_partner">
            <div class="muted">จ่ายให้ (พาร์ทเนอร์)</div><input name="partner_name" id="new_cash_partner_name" placeholder="ชื่อผู้รับเงิน (ถ้าไม่ได้เลือกจากลิสต์)" />
          </div>
        </div>

        <div style="height:14px"></div>
        <div class="actions" style="justify-content:flex-end">
          <button type="button" class="secondary" id="btnCancelNewCash">ยกเลิก</button>
          <button type="submit">บันทึก</button>
        </div>
      </form>
    </dialog>

    <dialog id="dlgCashDetail" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <div class="card" style="border:none;margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0" id="cashTitle">รายละเอียด</h3>
          <button type="button" class="secondary" id="btnCloseCashDetail">ปิด</button>
        </div>

        <form method="post" action="/admin/cash/update?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
          <input type="hidden" name="id" id="cash_id" />

          <div style="height:12px"></div>
          <div class="row3">
            <div>
              <div class="muted">ประเภท</div>
              <select name="type" id="cash_type" required>
                <option value="income">รายรับ</option>
                <option value="expense">รายจ่าย</option>
              </select>
            </div>
            <div>
              <div class="muted">จำนวนเงิน</div>
              <input name="amount" id="cash_amount" type="number" step="0.01" required />
            </div>
            <div>
              <div class="muted">วันที่</div>
              <input name="entry_date" id="cash_date" type="date" required />
            </div>
          </div>
          <div style="height:10px"></div>
          <div class="row">
            <div id="wrap_cash_customer">
              <div class="muted">รับจาก (ลูกค้า)</div><input name="customer_label" id="cash_customer_label" />
            </div>
            <div>
              <div class="muted">หมายเหตุ</div>
              <input name="note" id="cash_note" />
            </div>
            <div id="wrap_cash_partner">
              <div class="muted">จ่ายให้ (พาร์ทเนอร์)</div><input name="partner_name" id="cash_partner_name" />
            </div>
          </div>

          <div style="height:14px"></div>
          <div class="actions" style="justify-content:flex-end">
            <button type="submit">บันทึก</button>
          </div>
        </form>

        <div style="height:10px"></div>
        <form method="post" action="/admin/cash/delete?token=${escapeHtml(ADMIN_TOKEN)}" onsubmit="return confirm('ลบรายการนี้?')" style="margin:0">
          <input type="hidden" name="id" id="cash_delete_id" />
          <button type="submit" class="danger">ลบ</button>
        </form>
      </div>
    </dialog>

    <div style="height:12px"></div>
    <div class="card" style="padding:0">
      ${rows.map(r => {
        const sign = r.type === 'income' ? '+' : '-';
        const color = r.type === 'income' ? '#0b6' : '#b00020';
        return `
          <button type="button" class="secondary" style="width:100%;text-align:left;border:none;border-bottom:1px solid #eee;border-radius:0;padding:14px 14px" onclick="openCashDetail(${escapeHtml(JSON.stringify(r.id))})">
            <div class="actions" style="justify-content:space-between;align-items:flex-start">
              <div>
                <div><b>${escapeHtml(r.type==='income' ? ('รับจาก: '+(r.customer_label||'')) : ('จ่ายให้: '+(r.partner_name||'')))}</b></div>
                <div class="muted">${escapeHtml(String(r.entry_date).slice(0,10))}${r.note ? ' · ' + escapeHtml(r.note) : ''}</div>
              </div>
              <div style="font-weight:900;color:${color}">${sign}${Number(r.amount||0).toLocaleString('th-TH')}</div>
            </div>
          </button>
        `;
      }).join('')}
    </div>

    <script>
      (function(){
        var rows = ${JSON.stringify(rows).replace(/</g,'\\u003c')};
        var byId = new Map(rows.map(r => [Number(r.id), r]));

        var dlgNew = document.getElementById('dlgNewCash');
        var btnNewIncome = document.getElementById('btnNewIncome');
        var btnNewExpense = document.getElementById('btnNewExpense');
        var btnCloseNew = document.getElementById('btnCloseNewCash');
        var btnCancelNew = document.getElementById('btnCancelNewCash');

        var dlgD = document.getElementById('dlgCashDetail');
        var btnCloseD = document.getElementById('btnCloseCashDetail');

        var elId = document.getElementById('cash_id');
        var elType = document.getElementById('cash_type');
        var elAmt = document.getElementById('cash_amount');
        var elNote = document.getElementById('cash_note');
        var elCustLabel = document.getElementById('cash_customer_label');
        var elPartnerName = document.getElementById('cash_partner_name');

        function toggleCashType(t){
          var isIncome = (t !== 'expense');
          var wrapC = document.getElementById('wrap_cash_customer');
          var wrapP = document.getElementById('wrap_cash_partner');
          if (wrapC) wrapC.style.opacity = isIncome ? '1' : '0.5';
          if (wrapP) wrapP.style.opacity = isIncome ? '0.5' : '1';
          if (elCustLabel) elCustLabel.disabled = !isIncome;
          if (elPartnerName) elPartnerName.disabled = isIncome;
        }

        var elDate = document.getElementById('cash_date');
        var delId = document.getElementById('cash_delete_id');

        function openDlg(d){ if(d && d.showModal) d.showModal(); else if(d) d.setAttribute('open','open'); }
        function closeDlg(d){ if(d && d.close) d.close(); else if(d) d.removeAttribute('open'); }

        function setNewType(t){
          var inp = document.getElementById('new_cash_type');
          var lab = document.getElementById('new_cash_type_label');
          var wrapC = document.getElementById('wrap_new_customer');
          var wrapP = document.getElementById('wrap_new_partner');
          var inC = document.getElementById('new_cash_customer_label');
          var inP = document.getElementById('new_cash_partner_name');

          if (inp) inp.value = (t==='expense'?'expense':'income');
          if (lab) lab.textContent = (t==='expense'?'รายจ่าย':'รายรับ');

          var isIncome = (t !== 'expense');
          if (wrapC) wrapC.style.opacity = isIncome ? '1' : '0.5';
          if (wrapP) wrapP.style.opacity = isIncome ? '0.5' : '1';
          if (inC) inC.disabled = !isIncome;
          if (inP) inP.disabled = isIncome;

          // Clear the other side to avoid accidental mixed data
          if (isIncome) {
            if (inP) inP.value = '';
          } else {
            if (inC) inC.value = '';
          }
        }

        if (btnNewIncome) btnNewIncome.addEventListener('click', function(){ setNewType('income'); openDlg(dlgNew); });
        if (btnNewExpense) btnNewExpense.addEventListener('click', function(){ setNewType('expense'); openDlg(dlgNew); });
        if (btnCloseNew) btnCloseNew.addEventListener('click', function(){ closeDlg(dlgNew); });
        if (btnCancelNew) btnCancelNew.addEventListener('click', function(){ closeDlg(dlgNew); });

        window.openCashDetail = function(id){
          var r = byId.get(Number(id));
          if(!r) return;
          elId.value = r.id;
          delId.value = r.id;
          elType.value = r.type;
          toggleCashType(r.type);
          elAmt.value = String(r.amount||0);
          elNote.value = r.note || '';
          if (elCustLabel) elCustLabel.value = r.customer_label || '';
          if (elPartnerName) elPartnerName.value = r.partner_name || '';
          elDate.value = String(r.entry_date).slice(0,10);
          openDlg(dlgD);
        };

        if (elType) elType.addEventListener('change', function(){ toggleCashType(elType.value); });
        if (btnCloseD) btnCloseD.addEventListener('click', function(){ closeDlg(dlgD); });
      })();
    </script>
  </div>
  `;

  res.type('html').send(adminLayout({ title: 'รายรับรายจ่าย', active: 'cash', msg: req.query.msg ? String(req.query.msg) : '', body }));
});

app.post('/admin/cash/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { type, amount, note, entry_date, customer_label, partner_name } = req.body || {};
  const tp = (type === 'income' || type === 'expense') ? type : null;
  const amt = Number(amount);
  const cat = '';
  const nt = String(note||'').trim();
  const d = String(entry_date||'').slice(0,10);

  if (!tp) return redirectAdminTo(res, '/admin/cash', 'type ไม่ถูกต้อง');
  if (!Number.isFinite(amt) || amt <= 0) return redirectAdminTo(res, '/admin/cash', 'จำนวนเงินไม่ถูกต้อง');
    if (!d) return redirectAdminTo(res, '/admin/cash', 'วันที่หาย');

  const custTok = '';
  const custLabel = String(customer_label || '').trim();
  const partnerId = null;
  const partnerName = String(partner_name || '').trim();

  // Validation rules:
  // - income: must have (custTok or custLabel)
  // - expense: must have (partnerId or partnerName)
  if (tp === 'income') {
    if (!custTok && !custLabel) return redirectAdminTo(res, '/admin/cash', 'กรุณาระบุผู้จ่ายเงิน (ลูกค้า)');
  }
  if (tp === 'expense') {
    if (!partnerId && !partnerName) return redirectAdminTo(res, '/admin/cash', 'กรุณาระบุผู้รับเงิน (พาร์ทเนอร์)');
  }


  const p = await db();
  await p.execute(
    'INSERT INTO cash_entries(type,amount,category,note,entry_date,customer_token,customer_label,partner_id,partner_name) VALUES (?,?,?,?,?,?,?,?,?)',
    [tp, amt, cat, nt, d, custTok || null, custLabel || null, partnerId, partnerName || null]
  );
  return redirectAdminTo(res, '/admin/cash', 'บันทึกแล้ว');
});

app.post('/admin/cash/update', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id, type, amount, note, entry_date, customer_label, partner_name } = req.body || {};
  const cid = Number(id);
  const tp = (type === 'income' || type === 'expense') ? type : null;
  const amt = Number(amount);
  const cat = '';
  const nt = String(note||'').trim();
  const d = String(entry_date||'').slice(0,10);

  if (!cid) return redirectAdminTo(res, '/admin/cash', 'id หาย');
  if (!tp) return redirectAdminTo(res, '/admin/cash', 'type ไม่ถูกต้อง');
  if (!Number.isFinite(amt) || amt <= 0) return redirectAdminTo(res, '/admin/cash', 'จำนวนเงินไม่ถูกต้อง');
    if (!d) return redirectAdminTo(res, '/admin/cash', 'วันที่หาย');

  const custTok = '';
  const custLabel = String(customer_label || '').trim();
  const partnerId = null;
  const partnerName = String(partner_name || '').trim();

  // Validation rules:
  // - income: must have (custTok or custLabel)
  // - expense: must have (partnerId or partnerName)
  if (tp === 'income') {
    if (!custTok && !custLabel) return redirectAdminTo(res, '/admin/cash', 'กรุณาระบุผู้จ่ายเงิน (ลูกค้า)');
  }
  if (tp === 'expense') {
    if (!partnerId && !partnerName) return redirectAdminTo(res, '/admin/cash', 'กรุณาระบุผู้รับเงิน (พาร์ทเนอร์)');
  }


  const p = await db();
  await p.execute(
    'UPDATE cash_entries SET type=?, amount=?, category=?, note=?, entry_date=?, customer_token=?, customer_label=?, partner_id=?, partner_name=? WHERE id=?',
    [tp, amt, cat, nt, d, custTok || null, custLabel || null, partnerId, partnerName || null, cid]
  );
  return redirectAdminTo(res, '/admin/cash', 'บันทึกแล้ว');
});

app.post('/admin/cash/delete', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const cid = Number((req.body && req.body.id) || 0);
  if (!cid) return redirectAdminTo(res, '/admin/cash', 'id หาย');
  const p = await db();
  await p.execute('DELETE FROM cash_entries WHERE id=?', [cid]);
  return redirectAdminTo(res, '/admin/cash', 'ลบแล้ว');
});


// --- customer order pages (minimal; full UX can be re-added) ---
app.get('/c/:customerToken', async (req, res) => {
  const customerToken = String(req.params.customerToken || '');
  const customer = await getCustomerByToken(customerToken);
  if (!customer || customer.enabled === 0) return res.status(404).type('html').send('ไม่พบหน้าลูกค้านี้ครับ');
  const veggies = await getVeggiesForCustomer(customerToken);
  const deliveryTimes = await getDeliveryTimes();

  res.type('html').send(`<!doctype html><html lang="th"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>สั่งผัก</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto;max-width:860px;margin:18px auto;padding:0 12px} .card{border:1px solid #e7e7e7;border-radius:14px;padding:12px 14px;margin:12px 0} .muted{color:#666;font-size:12px} .row{display:flex;gap:10px;align-items:center;justify-content:space-between} button{padding:10px 12px;border-radius:12px;border:1px solid #111;background:#111;color:#fff;font-weight:700} input{padding:10px 12px;border-radius:12px;border:1px solid #ddd;width:70px;text-align:right}</style>
  </head><body>
  <div class="row"><button type="button" onclick="(history.length>1)?history.back():location.href='/'">←</button><b>สั่งผัก</b><span class="muted">${escapeHtml(customer.label||customerToken)}</span></div>
  <div class="card">
    <div class="muted">เลือกเวลาส่ง</div>
    <select id="deliveryTimeId" style="width:100%;padding:10px 12px;border-radius:12px;border:1px solid #ddd;font-size:18px">
      ${deliveryTimes.length ? deliveryTimes.map(dt => `<option value="${escapeHtml(dt.id)}" ${customer.default_delivery_time_id && Number(customer.default_delivery_time_id)===Number(dt.id) ? 'selected' : ''}>${escapeHtml(dt.name)} (${escapeHtml(dt.time_hm||'')})</option>`).join('') : '<option value="" disabled selected>ยังไม่ได้ตั้งเวลาส่ง</option>'}
    </select>
  </div>
  <div class="card" id="list"></div>
  <div class="card"><button id="btnSend">ส่งออเดอร์</button> <span class="muted" id="msg"></span></div>
  <script>
    const VEGS = ${JSON.stringify(veggies)};
    const customerToken = ${JSON.stringify(customerToken)};
    const list = document.getElementById('list');
    const msg = document.getElementById('msg');
    const dtEl = document.getElementById('deliveryTimeId');
    const qty = {};
    function render(){
      list.innerHTML = VEGS.map(function(v){
        return [
          '<div class="row" style="padding:10px 0;border-top:1px solid #f0f0f0">',
          '  <div>',
          '    <div><b>' + String(v.name) + '</b> <span class="muted">' + String(v.unit||'') + '</span></div>',
          '    <div class="muted">' + String(v.price||0) + ' บาท</div>',
          '  </div>',
          '  <input type="number" min="0" value="0" data-id="' + String(v.id) + '">',
          '</div>'
        ].join('');
      }).join('');
      list.querySelectorAll('input[data-id]').forEach(function(inp){
        inp.addEventListener('input', function(){ qty[inp.dataset.id] = Number(inp.value||0); });
      });
    }
    render();
    document.getElementById('btnSend').addEventListener('click', async ()=>{
      msg.textContent='';
      const items = Object.entries(qty).filter(([,q])=>q>0).map(([vegId,qty])=>({vegId,qty}));
      if(!items.length){ msg.textContent='ยังไม่ได้เลือกผักครับ'; return; }
      const deliveryTimeId = Number(dtEl && dtEl.value || 0);
      const r = await fetch('/api/order', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ customerToken, items, deliveryOffset:0, deliveryTimeId })});
      const data = await r.json();
      if(!r.ok){ msg.textContent=data.error||'ส่งไม่สำเร็จ'; return; }
      msg.textContent='ส่งแล้ว: '+data.orderId;
      setTimeout(()=>location.reload(), 800);
    });
  </script>
  </body></html>`);
});

app.post('/api/order', async (req, res) => {
  const { customerToken, guestToken, customerName, items, deliveryOffset, deliveryTimeId } = req.body || {};
  if ((!customerToken || typeof customerToken !== 'string') && (!guestToken || typeof guestToken !== 'string')) {
    return res.status(400).json({ error: 'ต้องมี customerToken หรือ guestToken ครับ' });
  }
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items ว่างครับ' });

  let customer = null;
  if (customerToken) {
    customer = await getCustomerByToken(customerToken);
    if (!customer || customer.enabled === 0) return res.status(404).json({ error: 'ไม่พบหน้าลูกค้านี้ครับ' });
  } else {
    // guest flow not reconstructed here
    return res.status(400).json({ error: 'guest flow ยังไม่พร้อมใน build นี้' });
  }

  const veggies = await getVeggiesForCustomer(customerToken);
  const vegMap = new Map(veggies.map(v => [v.id, v]));
  const normalized = [];
  for (const it of items) {
    const veg = vegMap.get(it.vegId);
    const qty = Number(it.qty);
    if (!veg) return res.status(400).json({ error: `ไม่รู้จักผัก: ${it.vegId}` });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: `จำนวนไม่ถูกต้อง: ${veg.name}` });
    normalized.push({ veg, qty });
  }

  const off = Number(deliveryOffset ?? 0);
  if (![0,1,2,3].includes(off)) return res.status(400).json({ error: 'deliveryOffset ไม่ถูกต้องครับ' });

  let dtId = Number(deliveryTimeId || 0);
  if (!dtId && customer && customer.default_delivery_time_id) dtId = Number(customer.default_delivery_time_id);
  if (!dtId) return res.status(400).json({ error: 'กรุณาเลือกเวลาส่งครับ' });

  const dtList = await getDeliveryTimes();
  const dt = dtList.find(x => Number(x.id) === dtId);
  if (!dt) return res.status(400).json({ error: 'เวลาส่งไม่ถูกต้องครับ' });

  const deliveryDate = off === 0 ? bangkokYmd(new Date()) : bangkokAddDaysYmd(off);
  const orderId = stableId();
  const createdAt = new Date();
  const ua = req.get('user-agent') || '';

  const p = await db();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      'INSERT INTO orders(order_id, customer_token, guest_token, guest_label, customer_label, created_at, user_agent, status, delivery_date, delivery_time_id, delivery_time_name, delivery_time_hm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [orderId, customerToken, null, null, customer.label || customerToken, createdAt, ua, 'new', deliveryDate, dtId, dt.name, dt.time_hm]
    );
    for (const it of normalized) {
      await conn.execute(
        'INSERT INTO order_items(order_id, veg_id, name_snapshot, unit_snapshot, price_snapshot, qty) VALUES (?,?,?,?,?,?)',
        [orderId, it.veg.id, it.veg.name, it.veg.unit || '', Number(it.veg.price || 0), it.qty]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error(e);
    return res.status(500).json({ error: 'บันทึกออเดอร์ไม่สำเร็จ' });
  } finally {
    conn.release();
  }

  return res.json({ ok: true, orderId });
});





// --- admin customers ---
app.get('/admin/customers', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const groups = await getAllCustomerGroups();
  const customers = await getAllCustomers();
  const p = await db();
  const [deliveryTimes] = await p.query('SELECT id,name,time_hm FROM delivery_times ORDER BY id ASC');

  const groupOptions = ['<option value="">(ไม่จัดกลุ่ม)</option>'].concat(
    groups.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`)
  ).join('');

  const deliveryOptions = ['<option value="">(ไม่ตั้งค่า)</option>'].concat(
    deliveryTimes.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}${d.time_hm ? ' ('+escapeHtml(d.time_hm)+')' : ''}</option>`)
  ).join('');

  const msg = req.query.msg ? String(req.query.msg) : '';
  const t = encodeURIComponent(ADMIN_TOKEN);

  const body = `
  <div class="card">
    <h2 style="margin:0 0 8px">จัดการลูกค้า</h2>
    <div class="muted">เพิ่ม/แก้ไข/ลบลูกค้า + คัดลอกลิงก์สั่งผัก</div>

    <div class="actions" style="margin:18px 0 8px;justify-content:space-between">
      <h3 style="margin:0">ลูกค้า</h3>
      <button type="button" id="btnNewCustomer">+ เพิ่มลูกค้าใหม่</button>
    </div>

    <dialog id="dlgNewCustomer" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <form method="post" action="/admin/customer/create?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">เพิ่มลูกค้าใหม่</h3>
          <button type="button" class="secondary" id="btnCloseNewCustomer">ปิด</button>
        </div>
        <div class="muted" style="margin-top:6px">ปล่อย token ว่างได้ ระบบจะสุ่มให้ครับ</div>
        <div style="height:12px"></div>

        <div class="row3">
          <div>
            <div class="muted">token</div>
            <input name="customerToken" placeholder="เช่น aom_01" />
          </div>
          <div>
            <div class="muted">ชื่อที่แสดง (label)</div>
            <input name="label" placeholder="เช่น คุณอ้อม" required />
          </div>
          <div>
            <div class="muted">กลุ่ม</div>
            <select name="group_id">${groupOptions}</select>
          </div>
        </div>

        <div style="height:10px"></div>
        <div>
          <div class="muted">หมายเหตุ</div>
          <input name="note" placeholder="เช่น ส่งของช่วงเย็น" />
        </div>

        <div style="height:10px"></div>
        <div>
          <div class="muted">เวลาส่งเริ่มต้น (default)</div>
          <select name="default_delivery_time_id">${deliveryOptions}</select>
        </div>

        <div style="height:14px"></div>
        <div class="actions" style="justify-content:flex-end">
          <button type="button" class="secondary" id="btnCancelNewCustomer">ยกเลิก</button>
          <button type="submit">เพิ่มลูกค้า</button>
        </div>
      </form>
    </dialog>

    <dialog id="dlgEditCustomer" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <form method="post" action="/admin/customer/update?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
        <input type="hidden" name="customerToken" id="edit_customerToken" />
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">แก้ไขลูกค้า</h3>
          <button type="button" class="secondary" id="btnCloseEditCustomer">ปิด</button>
        </div>
        <div class="muted" id="edit_token_show" style="margin-top:6px"></div>
        <div style="height:12px"></div>

        <div class="row3">
          <div>
            <div class="muted">ชื่อที่แสดง (label)</div>
            <input name="label" id="edit_label" required />
          </div>
          <div>
            <div class="muted">กลุ่ม</div>
            <select name="group_id" id="edit_group">${groupOptions}</select>
          </div>
          <div>
            <div class="muted">เปิดใช้งาน</div>
            <select name="enabled" id="edit_enabled">
              <option value="1">on</option>
              <option value="0">off</option>
            </select>
          </div>
        </div>

        <div style="height:10px"></div>
        <div>
          <div class="muted">หมายเหตุ</div>
          <input name="note" id="edit_note" />
        </div>

        <div style="height:10px"></div>
        <div>
          <div class="muted">เวลาส่งเริ่มต้น (default)</div>
          <select name="default_delivery_time_id" id="edit_default_delivery_time">${deliveryOptions}</select>
        </div>

        <div style="height:14px"></div>
        <div class="actions" style="justify-content:flex-end">
          <button type="button" class="secondary" id="btnCancelEditCustomer">ยกเลิก</button>
          <button type="submit">บันทึก</button>
        </div>
      </form>
    </dialog>

    <div class="card" style="padding:0">
      ${customers.map(c => {
        const disabledBadge = c.enabled ? '' : '<span class="pill" style="background:#f2f2f2;color:#111">disabled</span>';
        return `
          <button type="button" class="secondary" style="width:100%;text-align:left;border:none;border-bottom:1px solid #eee;border-radius:0;padding:14px 14px" onclick="openCustomerDetail(${escapeHtml(JSON.stringify(c.token))})">
            <div class="actions" style="justify-content:space-between;align-items:center">
              <div><b>${escapeHtml(c.label)}</b> ${disabledBadge}</div>
              <div class="muted">→</div>
            </div>
          </button>
        `;
      }).join('')}
    </div>

    <dialog id="dlgCustomerDetail" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <div class="card" style="border:none;margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0" id="custDetailTitle">รายละเอียดลูกค้า</h3>
          <button type="button" class="secondary" id="btnCloseCustDetail">ปิด</button>
        </div>
        <div class="muted" id="custDetailToken" style="margin-top:6px"></div>

        <div style="height:12px"></div>
        <div class="card" style="margin:0">
          <div class="muted">กลุ่ม</div>
          <div id="custDetailGroup" style="font-weight:800"></div>
          <div style="height:10px"></div>
          <div class="muted">เวลาส่งเริ่มต้น</div>
          <div id="custDetailDefaultDt" style="font-weight:800"></div>
          <div style="height:10px"></div>
          <div class="muted">หมายเหตุ</div>
          <div id="custDetailNote" class="muted"></div>
        </div>

        <div style="height:12px"></div>
        <div class="actions" style="justify-content:flex-end">
          <a class="muted" id="custDetailOpenLink" target="_blank" rel="noopener" style="padding:10px 12px;border-radius:12px;border:1px solid #ddd;text-decoration:none">เปิดลิงก์</a>
          <button type="button" class="secondary" id="custDetailCopyLink">คัดลอกลิงก์</button>
          <a class="muted" id="custDetailPrices" style="padding:10px 12px;border-radius:12px;border:1px solid #ddd;text-decoration:none">ตั้งราคา</a>
          <button type="button" class="secondary" id="custDetailEdit">แก้ไข</button>
          <form method="post" action="/admin/customer/delete?token=${escapeHtml(ADMIN_TOKEN)}" onsubmit="return confirm('ลบลูกค้าคนนี้?')" style="margin:0">
            <input type="hidden" name="customerToken" id="custDetailDeleteTok" />
            <button type="submit" class="danger">ลบ</button>
          </form>
        </div>
      </div>
    </dialog>

    <script>
      (function(){
        var customers = ${JSON.stringify(customers).replace(/</g,'\\u003c')};
        var deliveryTimes = ${JSON.stringify(deliveryTimes).replace(/</g,'\\u003c')};
        var byTok = new Map(customers.map(c => [c.token, c]));

        var dlgD = document.getElementById('dlgCustomerDetail');
        var btnCloseD = document.getElementById('btnCloseCustDetail');
        var elTitle = document.getElementById('custDetailTitle');
        var elTok = document.getElementById('custDetailToken');
        var elGroup = document.getElementById('custDetailGroup');
        var elDt = document.getElementById('custDetailDefaultDt');
        var elNote = document.getElementById('custDetailNote');
        var aOpen = document.getElementById('custDetailOpenLink');
        var btnCopy = document.getElementById('custDetailCopyLink');
        var aPrices = document.getElementById('custDetailPrices');
        var btnEdit = document.getElementById('custDetailEdit');
        var delTok = document.getElementById('custDetailDeleteTok');

        function openDlg(d){ if(d && d.showModal) d.showModal(); else if(d) d.setAttribute('open','open'); }
        function closeDlg(d){ if(d && d.close) d.close(); else if(d) d.removeAttribute('open'); }

        window.openCustomerDetail = function(token){
          var c = byTok.get(token);
          if(!c) return;
          elTitle.textContent = c.label || 'ลูกค้า';
          elTok.textContent = 'token: ' + c.token;
          elGroup.textContent = c.group_name || '-';
          var dt = deliveryTimes.find(x => Number(x.id) === Number(c.default_delivery_time_id||0));
          elDt.textContent = dt ? (dt.name + (dt.time_hm ? (' ('+dt.time_hm+')') : '')) : '-';
          elNote.textContent = c.note || '-';

          var link = ${JSON.stringify(BASE_URL)} + '/c/' + c.token;
          aOpen.href = link;
          btnCopy.onclick = function(){
            if(window.copyText) window.copyText(link).then(ok=>{ if(ok) alert('คัดลอกลิงก์แล้ว'); });
          };
          aPrices.href = '/admin/customer-prices?token=${escapeHtml(ADMIN_TOKEN)}&customerToken=' + encodeURIComponent(c.token);
          btnEdit.onclick = function(){
            closeDlg(dlgD);
            openEditCustomer(c.token, c.label, c.note||'', c.group_id||'', c.enabled?1:0, c.use_group_price?1:0, c.default_delivery_time_id||null);
          };
          delTok.value = c.token;

          openDlg(dlgD);
        };

        if(btnCloseD) btnCloseD.addEventListener('click', function(){ closeDlg(dlgD); });

        var btn = document.getElementById('btnNewCustomer');
        var dlg = document.getElementById('dlgNewCustomer');
        var close1 = document.getElementById('btnCloseNewCustomer');
        var close2 = document.getElementById('btnCancelNewCustomer');
        if(btn && dlg){
          function openDlgNew(){ if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','open'); }
          function closeDlgNew(){ if(dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
          btn.addEventListener('click', openDlgNew);
          if(close1) close1.addEventListener('click', closeDlgNew);
          if(close2) close2.addEventListener('click', closeDlgNew);
        }

        var dlg2 = document.getElementById('dlgEditCustomer');
        var closeE1 = document.getElementById('btnCloseEditCustomer');
        var closeE2 = document.getElementById('btnCancelEditCustomer');
        var elTok2 = document.getElementById('edit_customerToken');
        var elShow = document.getElementById('edit_token_show');
        var elLabel = document.getElementById('edit_label');
        var elNote2 = document.getElementById('edit_note');
        var elGroup2 = document.getElementById('edit_group');
        var elEnabled = document.getElementById('edit_enabled');
        var elDefault = document.getElementById('edit_default_delivery_time');

        function openEDlg(){ if(dlg2 && dlg2.showModal) dlg2.showModal(); else if(dlg2) dlg2.setAttribute('open','open'); }
        function closeEDlg(){ if(dlg2 && dlg2.close) dlg2.close(); else if(dlg2) dlg2.removeAttribute('open'); }

        window.openEditCustomer = function(token, label, note, groupId, enabled, useGroupPrice, defaultDeliveryTimeId){
          elTok2.value = token;
          elShow.textContent = 'token: ' + token;
          elLabel.value = label || '';
          elNote2.value = note || '';
          elEnabled.value = String(enabled||'1');
          elGroup2.value = (groupId===null||groupId===undefined)?'':String(groupId);
          if (elDefault) elDefault.value = (defaultDeliveryTimeId===null||defaultDeliveryTimeId===undefined)?'':String(defaultDeliveryTimeId);
          openEDlg();
        };

        if(closeE1) closeE1.addEventListener('click', closeEDlg);
        if(closeE2) closeE2.addEventListener('click', closeEDlg);
      })();
    </script>
  </div>
  `;

  res.type('html').send(adminLayout({ title: 'ลูกค้า', active: 'customers', msg, body }));
});

app.post('/admin/customer/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let { customerToken, label, note, enabled, group_id, use_group_price, default_delivery_time_id } = req.body || {};
  const useGroup = String(use_group_price) === '1' ? 1 : 0;
  const defaultDtId = default_delivery_time_id ? Number(default_delivery_time_id) : null;

  customerToken = String(customerToken || '').trim();
  label = String(label || '').trim();
  note = String(note || '').trim();
  enabled = String(enabled) === '0' ? 0 : 1;
  const gid = group_id ? Number(group_id) : null;

  if (!label) return redirectAdminTo(res, '/admin/customers', 'label หาย');

  customerToken = String(customerToken || '').trim();
  if (!customerToken) customerToken = nanoid(10);

  const p = await db();
  try {
    await p.execute(
      'INSERT INTO customers(token,label,note,enabled,group_id,use_group_price,default_delivery_time_id) VALUES (?,?,?,?,?,?,?)',
      [customerToken, label, note, enabled, gid, useGroup, defaultDtId]
    );
  } catch (e) {
    console.error(e);
    return redirectAdminTo(res, '/admin/customers', 'เพิ่มลูกค้าไม่สำเร็จ (token ซ้ำ?)');
  }
  return redirectAdminTo(res, '/admin/customers', 'เพิ่มลูกค้าแล้ว');
});

app.post('/admin/customer/update', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { customerToken, label, note, enabled, group_id, use_group_price, default_delivery_time_id } = req.body || {};
  const useGroup = String(use_group_price) === '1' ? 1 : 0;
  const defaultDtId = default_delivery_time_id ? Number(default_delivery_time_id) : null;

  const tok = String(customerToken || '').trim();
  if (!tok) return redirectAdminTo(res, '/admin/customers', 'token หาย');

  const p = await db();
  await p.execute(
    'UPDATE customers SET label=?, note=?, enabled=?, group_id=?, use_group_price=?, default_delivery_time_id=? WHERE token=?',
    [String(label||'').trim(), String(note||'').trim(), String(enabled)==='0'?0:1, group_id?Number(group_id):null, useGroup, defaultDtId, tok]
  );
  return redirectAdminTo(res, '/admin/customers', 'บันทึกแล้ว');
});

app.post('/admin/customer/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let { customerToken, label, note, enabled, group_id, use_group_price, default_delivery_time_id } = req.body || {};
  const useGroup = String(use_group_price) === '1' ? 1 : 0;
  const defaultDtId = default_delivery_time_id ? Number(default_delivery_time_id) : null;

  customerToken = String(customerToken || '').trim();
  label = String(label || '').trim();
  note = String(note || '').trim();
  enabled = String(enabled) === '0' ? 0 : 1;
  const gid = group_id ? Number(group_id) : null;

  if (!label) return redirectAdminTo(res, '/admin/customers', 'label หาย');
  if (!customerToken) customerToken = nanoid(10);

  const p = await db();
  try {
    await p.execute(
      'INSERT INTO customers(token,label,note,enabled,group_id,use_group_price,default_delivery_time_id) VALUES (?,?,?,?,?,?,?)',
      [customerToken, label, note, enabled, gid, useGroup, defaultDtId]
    );
  } catch (e) {
    console.error(e);
    return redirectAdminTo(res, '/admin/customers', 'เพิ่มลูกค้าไม่สำเร็จ (token ซ้ำ?)');
  }
  return redirectAdminTo(res, '/admin/customers', 'เพิ่มลูกค้าแล้ว');
});

app.post('/admin/customer/update', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { customerToken, label, note, enabled, group_id, use_group_price, default_delivery_time_id } = req.body || {};
  const useGroup = String(use_group_price) === '1' ? 1 : 0;
  const defaultDtId = default_delivery_time_id ? Number(default_delivery_time_id) : null;

  const tok = String(customerToken || '').trim();
  if (!tok) return redirectAdminTo(res, '/admin/customers', 'token หาย');

  const p = await db();
  await p.execute(
    'UPDATE customers SET label=?, note=?, enabled=?, group_id=?, use_group_price=?, default_delivery_time_id=? WHERE token=?',
    [String(label||'').trim(), String(note||'').trim(), String(enabled)==='0'?0:1, group_id?Number(group_id):null, useGroup, defaultDtId, tok]
  );
  return redirectAdminTo(res, '/admin/customers', 'บันทึกแล้ว');
});


// --- admin veggies ---
app.get('/admin/veggies', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const veggies = await getVeggies();
  const msg = req.query.msg ? String(req.query.msg) : '';
  const t = encodeURIComponent(ADMIN_TOKEN);

  const body = `
  <div class="card">
    <div class="actions" style="justify-content:space-between;align-items:center">
      <div>
        <h2 style="margin:0">จัดการผัก</h2>
        <div class="muted">เพิ่ม/แก้ไข/ลบผัก</div>
      </div>
      <button type="button" id="btnNewVeg">+ เพิ่มผัก</button>
    </div>

    <dialog id="dlgNewVeg" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <form method="post" action="/admin/veg/create?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">เพิ่มผักใหม่</h3>
          <button type="button" class="secondary" id="btnCloseNewVeg">ปิด</button>
        </div>
        <div style="height:12px"></div>

        <div class="row3">
          <div>
            <div class="muted">id (ระบบจะสร้างให้)</div>
            <input name="id" id="newVegId" readonly />
          </div>
          <div>
            <div class="muted">ชื่อ</div>
            <input name="name" id="newVegName" required />
          </div>
          <div>
            <div class="muted">หน่วย</div>
            <input name="unit" placeholder="กำ/หัว/กก" />
          </div>
        </div>

        <div style="height:10px"></div>
        <div class="row3">
          <div>
            <div class="muted">ราคา</div>
            <input name="price" type="number" step="0.01" required />
          </div>
          <div>
            <div class="muted">sort_order</div>
            <input name="sort_order" type="number" step="1" value="0" />
          </div>
          <div>
            <div class="muted">เปิดใช้งาน</div>
            <select name="enabled">
              <option value="1" selected>ใช่</option>
              <option value="0">ไม่</option>
            </select>
          </div>
        </div>

        <div style="height:14px"></div>
        <div class="actions" style="justify-content:flex-end">
          <button type="button" class="secondary" id="btnCancelNewVeg">ยกเลิก</button>
          <button type="submit">เพิ่มผัก</button>
        </div>
      </form>
    </dialog>

    <div class="card" style="padding:0">
      ${veggies.map(v => {
        return `
          <button type="button" class="secondary" style="width:100%;text-align:left;border:none;border-bottom:1px solid #eee;border-radius:0;padding:14px 14px" onclick="openVegDetail(${escapeHtml(JSON.stringify(v.id))})">
            <div class="actions" style="justify-content:space-between;align-items:center">
              <div>
                <div><b>${escapeHtml(v.name)}</b> <span class="muted">${escapeHtml(v.unit||'')}</span></div>
                <div class="muted">${escapeHtml(Number(v.price||0).toLocaleString('th-TH'))} บาท</div>
              </div>
              <div class="muted">→</div>
            </div>
          </button>
        `;
      }).join('')}
    </div>

    <dialog id="dlgVegDetail" style="border:1px solid #ddd;border-radius:14px;max-width:720px;width:95%">
      <div class="card" style="border:none;margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0" id="vegTitle">รายละเอียดผัก</h3>
          <button type="button" class="secondary" id="btnCloseVegDetail">ปิด</button>
        </div>
        <div class="muted" id="vegIdShow" style="margin-top:6px"></div>

        <form method="post" action="/admin/veg/update?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
          <input type="hidden" name="id" id="editVegId" />

          <div style="height:12px"></div>
          <div class="row3">
            <div>
              <div class="muted">ชื่อ</div>
              <input name="name" id="editVegName" required />
            </div>
            <div>
              <div class="muted">หน่วย</div>
              <input name="unit" id="editVegUnit" />
            </div>
            <div>
              <div class="muted">ราคา</div>
              <input name="price" id="editVegPrice" type="number" step="0.01" required />
            </div>
          </div>

          <div style="height:10px"></div>
          <div class="row3">
            <div>
              <div class="muted">sort_order</div>
              <input name="sort_order" id="editVegSort" type="number" step="1" />
            </div>
            <div></div>
            <div></div>
          </div>

          <div style="height:14px"></div>
          <div class="actions" style="justify-content:flex-end">
            <button type="submit">บันทึก</button>
          </div>
        </form>

        <div style="height:10px"></div>
        <form method="post" action="/admin/veg/delete?token=${escapeHtml(ADMIN_TOKEN)}" onsubmit="return confirm('ลบผักนี้?')" style="margin:0">
          <input type="hidden" name="id" id="vegDeleteId" />
          <button type="submit" class="danger">ลบ</button>
        </form>
      </div>
    </dialog>

    <script>
      (function(){
        function slugify(s){
          return String(s||'').trim().toLowerCase()
            .replace(/\s+/g,'_')
            .replace(/[^a-z0-9_]+/g,'')
            .replace(/_+/g,'_')
            .replace(/^_+|_+$/g,'');
        }
        function genId(){ return 'veg_' + Math.random().toString(36).slice(2,6); }

        var vegs = ${JSON.stringify(veggies).replace(/</g,'\\u003c')};
        var byId = new Map(vegs.map(v => [v.id, v]));

        var btn = document.getElementById('btnNewVeg');
        var dlg = document.getElementById('dlgNewVeg');
        var close1 = document.getElementById('btnCloseNewVeg');
        var close2 = document.getElementById('btnCancelNewVeg');

        function openNewVeg(){
          if (!dlg) return;
          if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','open');
          var idEl = document.getElementById('newVegId');
          var nameEl = document.getElementById('newVegName');
          if (idEl) idEl.value = genId();
          if (nameEl) {
            nameEl.value=''; nameEl.focus();
            nameEl.oninput = function(){
              var slug = slugify(nameEl.value);
              if (slug && idEl) idEl.value = slug;
            };
          }
        }
        function closeNewVeg(){
          if (!dlg) return;
          if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
        }

        if(btn && dlg){
          btn.addEventListener('click', openNewVeg);
          if(close1) close1.addEventListener('click', closeNewVeg);
          if(close2) close2.addEventListener('click', closeNewVeg);
        }

        var dlgD = document.getElementById('dlgVegDetail');
        var btnClose = document.getElementById('btnCloseVegDetail');
        var elTitle = document.getElementById('vegTitle');
        var elIdShow = document.getElementById('vegIdShow');
        var elId = document.getElementById('editVegId');
        var elName = document.getElementById('editVegName');
        var elUnit = document.getElementById('editVegUnit');
        var elPrice = document.getElementById('editVegPrice');
        var elSort = document.getElementById('editVegSort');
        var delId = document.getElementById('vegDeleteId');

        function openDlg(d){ if(d && d.showModal) d.showModal(); else if(d) d.setAttribute('open','open'); }
        function closeDlg(d){ if(d && d.close) d.close(); else if(d) d.removeAttribute('open'); }

        window.openVegDetail = function(id){
          // safety: close "new veg" dialog if it accidentally opened on iOS
          try { closeNewVeg(); } catch(e) {}

          var v = byId.get(String(id));
          if(!v) return;
          elTitle.textContent = v.name || 'ผัก';
          elIdShow.textContent = 'id: ' + v.id;
          elId.value = v.id;
          elName.value = v.name || '';
          elUnit.value = v.unit || '';
          elPrice.value = String(v.price||0);
          elSort.value = String(v.sort_order||0);
          delId.value = v.id;
          openDlg(dlgD);
        };

        if(btnClose) btnClose.addEventListener('click', function(){ closeDlg(dlgD); });
      })();
    </script>
  </div>
  `;

  res.type('html').send(adminLayout({ title: 'ผัก', active: 'veggies', msg, body }));
});

app.post('/admin/veg/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let { id, name, unit, price, enabled, sort_order } = req.body || {};
  id = String(id||'').trim();
  name = String(name||'').trim();
  unit = String(unit||'').trim();
  const p1 = Number(price||0);
  const en = String(enabled)==='0'?0:1;
  const so = Number(sort_order||0);
  if(!id) return redirectAdminTo(res,'/admin/veggies','id หาย');
  if(!name) return redirectAdminTo(res,'/admin/veggies','name หาย');
  const p = await db();
  try{
    await p.execute('INSERT INTO veggies(id,name,unit,price,enabled,sort_order) VALUES (?,?,?,?,?,?)', [id,name,unit,p1,en,so]);
  }catch(e){
    console.error(e);
    return redirectAdminTo(res,'/admin/veggies','เพิ่มผักไม่สำเร็จ (id ซ้ำ?)');
  }
  return redirectAdminTo(res,'/admin/veggies','เพิ่มผักแล้ว');
});

app.post('/admin/veg/update', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let { id, name, unit, price, enabled, sort_order } = req.body || {};
  id = String(id||'').trim();
  if(!id) return redirectAdminTo(res,'/admin/veggies','id หาย');
  name = String(name||'').trim();
  unit = String(unit||'').trim();
  const p1 = Number(price||0);
  const en = String(enabled)==='0'?0:1;
  const so = Number(sort_order||0);
  const p = await db();
  await p.execute('UPDATE veggies SET name=?, unit=?, price=?, enabled=?, sort_order=? WHERE id=?', [name,unit,p1,en,so,id]);
  return redirectAdminTo(res,'/admin/veggies','บันทึกแล้ว');
});

app.post('/admin/veg/delete', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = String((req.body && req.body.id) || '').trim();
  if(!id) return redirectAdminTo(res,'/admin/veggies','id หาย');
  const p = await db();
  await p.execute('DELETE FROM veggies WHERE id=?', [id]);
  return redirectAdminTo(res,'/admin/veggies','ลบแล้ว');
});

// ---- restored route snippets ----


// SNIP: admin_groups_routes.txt
app.get('/admin/groups', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const groups = await getAllCustomerGroups();
  const msg = req.query.msg ? String(req.query.msg) : '';

  const body = `
  <div class="card">
    <h2 style="margin:0 0 8px">จัดการกลุ่มลูกค้า</h2>
    <div class="muted">เพิ่ม/แก้ไข/ลบกลุ่ม (ลบกลุ่มแล้ว ลูกค้าในกลุ่มจะถูกย้ายเป็นไม่จัดกลุ่มอัตโนมัติ)</div>

    <h3 style="margin:14px 0 8px">เพิ่มกลุ่มใหม่</h3>
    <form method="post" action="/admin/group/create?token=${escapeHtml(ADMIN_TOKEN)}" class="actions">
      <input name="name" placeholder="เช่น ตลาดธิดาพร" required />
      <button type="submit">เพิ่มกลุ่ม</button>
    </form>

    <h3 style="margin:18px 0 8px">รายการกลุ่ม</h3>
    <table>
      <thead><tr><th>กลุ่ม</th><th>จัดการ</th></tr></thead>
      <tbody>
        ${groups.map(g => `
          <tr>
            <td><b>${escapeHtml(g.name)}</b><div class="muted">id: ${escapeHtml(g.id)}</div></td>
            <td>
              <form method="post" action="/admin/group/update?token=${escapeHtml(ADMIN_TOKEN)}" class="actions">
                <input type="hidden" name="id" value="${escapeHtml(g.id)}" />
                <input name="name" value="${escapeHtml(g.name)}" />
                <button type="submit">บันทึก</button>
              </form>
              <div style="height:6px"></div>
              <form method="post" action="/admin/group/delete?token=${escapeHtml(ADMIN_TOKEN)}" onsubmit="return confirm('ลบกลุ่มนี้? ลูกค้าในกลุ่มจะถูกย้ายเป็นไม่จัดกลุ่ม')">
                <input type="hidden" name="id" value="${escapeHtml(g.id)}" />
                <button type="submit" class="danger">ลบกลุ่ม</button>
              </form>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
  `;

  res.type('html').send(adminLayout({ title: 'จัดการกลุ่มลูกค้า', active: 'groups', msg, body }));
});



// SNIP: admin_group_prices_routes.txt
app.get('/admin/group-prices', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const groupId = Number(req.query.groupId || 0);
  if (!groupId) return redirectAdminTo(res, '/admin/groups', 'groupId หาย');

  const p = await db();
  const [groups] = await p.execute('SELECT id,name FROM customer_groups WHERE id=? LIMIT 1', [groupId]);
  const g = groups[0];
  if (!g) return redirectAdminTo(res, '/admin/groups', 'ไม่พบกลุ่มนี้');

  const [vegs] = await p.query('SELECT id,name,unit,price FROM veggies WHERE enabled=1 ORDER BY sort_order ASC, name ASC');
  const [over] = await p.execute('SELECT veg_id, price FROM group_veg_prices WHERE group_id=?', [groupId]);
  const map = new Map(over.map(r => [r.veg_id, Number(r.price)]));
  const msg = req.query.msg ? String(req.query.msg) : '';

  const body = `
  <div class="card">
    <h2 style="margin:0 0 8px">ตั้งราคารายกลุ่ม</h2>
    <div class="muted">กลุ่ม: <b>${escapeHtml(g.name)}</b></div>
    <div class="muted">ถ้าไม่กรอกราคา จะใช้ (ถ้าลูกค้าไม่ตั้งราคาเอง) → ราคากลาง</div>

    <div style="height:12px"></div>
    <form method="post" action="/admin/group-prices/save?token=${escapeHtml(ADMIN_TOKEN)}">
      <input type="hidden" name="groupId" value="${escapeHtml(groupId)}" />

      <table>
        <thead>
          <tr>
            <th>ผัก</th>
            <th>ราคากลาง</th>
            <th>ราคากลุ่ม</th>
          </tr>
        </thead>
        <tbody>
          ${vegs.map(v => {
            const base = Number(v.price || 0);
            const cur = map.has(v.id) ? map.get(v.id) : '';
            return `
              <tr>
                <td><b>${escapeHtml(v.name)}</b> <span class="muted">${escapeHtml(v.unit || '')}</span></td>
                <td class="right">${escapeHtml(base.toLocaleString('th-TH'))}</td>
                <td>
                  <input name="price_${escapeHtml(v.id)}" type="number" step="0.01" placeholder="(ว่าง = ไม่ตั้ง)" value="${cur === '' ? '' : escapeHtml(cur)}" />
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>

      <div style="height:12px"></div>
      <div class="actions" style="justify-content:flex-end">
        <button type="submit">บันทึก</button>
      </div>
    </form>
  </div>
  `;

  res.type('html').send(adminLayout({ title: 'ตั้งราคารายกลุ่ม', active: 'groups', msg, body }));
});

app.post('/admin/group-prices/save', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const groupId = Number((req.body && req.body.groupId) || 0);
  if (!groupId) return redirectAdminTo(res, '/admin/groups', 'groupId หาย');

  const p = await db();
  const [vegs] = await p.query('SELECT id FROM veggies WHERE enabled=1');

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();

    for (const v of vegs) {
      const key = 'price_' + v.id;
      const raw = (req.body && req.body[key])
        ? String(req.body[key]).trim()
        : '';
      if (!raw) {
        await conn.execute('DELETE FROM group_veg_prices WHERE group_id=? AND veg_id=?', [groupId, v.id]);
      } else {
        const price = Number(raw);
        if (!Number.isFinite(price) || price < 0) continue;
        await conn.execute(
          'INSERT INTO group_veg_prices(group_id, veg_id, price) VALUES (?,?,?) ON DUPLICATE KEY UPDATE price=VALUES(price)',
          [groupId, v.id, price]
        );
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error(e);
    return redirectAdminTo(res, '/admin/groups', 'บันทึกราคาไม่สำเร็จ');
  } finally {
    conn.release();
  }

  const qs = new URLSearchParams({ token: ADMIN_TOKEN, groupId: String(groupId) });
  return res.redirect('/admin/group-prices?' + qs.toString() + '&msg=' + encodeURIComponent('บันทึกราคาแล้ว'));
});



// SNIP: admin_delivery_times_routes.txt
app.get('/admin/delivery-times', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const p = await db();
  const [rows] = await p.query('SELECT id,name,days_mask,time_hm,enabled FROM delivery_times ORDER BY enabled DESC, time_hm ASC, name ASC');
  const msg = req.query.msg ? String(req.query.msg) : '';

  const dayNames = ['จ','อ','พ','พฤ','ศ','ส','อา'];
  const fmtDays = (mask) => {
    if (Number(mask) === 127) return 'ทุกวัน';
    const out = [];
    for (let i=0;i<7;i++) {
      if (Number(mask) & (1<<i)) out.push(dayNames[i]);
    }
    return out.join(' ');
  };

  const body = `
  <div class="card">
    <div class="actions" style="justify-content:space-between;align-items:center">
      <div>
        <h2 style="margin:0">จัดการเวลาส่ง</h2>
        <div class="muted">แตะเพื่อดู/แก้ไขรายละเอียด</div>
      </div>
      <button type="button" id="btnNewDt">+ เพิ่มเวลา</button>
    </div>

    <div style="height:12px"></div>

    <div class="card" style="padding:0">
      ${rows.map(r => {
        const badge = r.enabled ? '' : '<span class="pill" style="background:#f2f2f2;color:#111">off</span>';
        return `
          <button type="button" class="secondary" style="width:100%;text-align:left;border:none;border-bottom:1px solid #eee;border-radius:0;padding:14px 14px" onclick="openDtDetail(${escapeHtml(JSON.stringify(r.id))})">
            <div class="actions" style="justify-content:space-between;align-items:center">
              <div>
                <div><b>${escapeHtml(r.name)}</b> ${badge}</div>
                <div class="muted">${escapeHtml(r.time_hm)}</div>
              </div>
              <div class="muted">→</div>
            </div>
          </button>
        `;
      }).join('')}
    </div>

    <dialog id="dlgNewDt" style="border:1px solid #ddd;border-radius:14px;max-width:560px;width:95%">
      <form method="post" action="/admin/delivery-time/create?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">เพิ่มเวลาส่ง</h3>
          <button type="button" class="secondary" id="btnCloseNewDt">ปิด</button>
        </div>

        <div style="height:12px"></div>
        <div>
          <div class="muted">ชื่อ</div>
          <input name="name" placeholder="เช่น ดึก" required />
        </div>
        <div style="height:10px"></div>
        <div>
          <div class="muted">เวลา</div>
          <input name="time_hm" type="time" required />
        </div>
        <div style="height:10px"></div>
        <div>
          <div class="muted">เปิดใช้งาน</div>
          <select name="enabled"><option value="1" selected>on</option><option value="0">off</option></select>
        </div>

        <div style="height:14px"></div>
        <div class="actions" style="justify-content:flex-end">
          <button type="button" class="secondary" id="btnCancelNewDt">ยกเลิก</button>
          <button type="submit">เพิ่ม</button>
        </div>
      </form>
    </dialog>

    <dialog id="dlgDtDetail" style="border:1px solid #ddd;border-radius:14px;max-width:560px;width:95%">
      <div class="card" style="border:none;margin:0">
        <div class="actions" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0" id="dt_title">รายละเอียดเวลาส่ง</h3>
          <button type="button" class="secondary" id="btnCloseDtDetail">ปิด</button>
        </div>

        <form method="post" action="/admin/delivery-time/update?token=${escapeHtml(ADMIN_TOKEN)}" style="margin:0">
          <input type="hidden" name="id" id="dt_id" />

          <div style="height:12px"></div>
          <div>
            <div class="muted">ชื่อ</div>
            <input name="name" id="dt_name" required />
          </div>
          <div style="height:10px"></div>
          <div>
            <div class="muted">เวลา</div>
            <input name="time_hm" id="dt_time" type="time" required />
          </div>
          <div style="height:10px"></div>
          <div>
            <div class="muted">เปิดใช้งาน</div>
            <select name="enabled" id="dt_enabled"><option value="1">on</option><option value="0">off</option></select>
          </div>

          <div style="height:14px"></div>
          <div class="actions" style="justify-content:flex-end">
            <button type="submit">บันทึก</button>
          </div>
        </form>

        <div style="height:10px"></div>
        <form method="post" action="/admin/delivery-time/delete?token=${escapeHtml(ADMIN_TOKEN)}" onsubmit="return confirm('ลบเวลาส่งนี้?')" style="margin:0">
          <input type="hidden" name="id" id="dt_delete_id" />
          <button class="danger" type="submit">ลบ</button>
        </form>
      </div>
    </dialog>

    <script>
      (function(){
        var rows = ${JSON.stringify(rows).replace(/</g,'\\u003c')};
        var byId = new Map(rows.map(r => [Number(r.id), r]));

        var dlgNew = document.getElementById('dlgNewDt');
        var btnNew = document.getElementById('btnNewDt');
        var btnCloseNew = document.getElementById('btnCloseNewDt');
        var btnCancelNew = document.getElementById('btnCancelNewDt');

        var dlgD = document.getElementById('dlgDtDetail');
        var btnCloseD = document.getElementById('btnCloseDtDetail');

        var elId = document.getElementById('dt_id');
        var elTitle = document.getElementById('dt_title');
        var elName = document.getElementById('dt_name');
        var elTime = document.getElementById('dt_time');
        var elEnabled = document.getElementById('dt_enabled');
        var delId = document.getElementById('dt_delete_id');

        function openDlg(d){ if(d && d.showModal) d.showModal(); else if(d) d.setAttribute('open','open'); }
        function closeDlg(d){ if(d && d.close) d.close(); else if(d) d.removeAttribute('open'); }

        if (btnNew) btnNew.addEventListener('click', function(){ openDlg(dlgNew); });
        if (btnCloseNew) btnCloseNew.addEventListener('click', function(){ closeDlg(dlgNew); });
        if (btnCancelNew) btnCancelNew.addEventListener('click', function(){ closeDlg(dlgNew); });

        window.openDtDetail = function(id){
          var r = byId.get(Number(id));
          if(!r) return;
          elId.value = r.id;
          delId.value = r.id;
          elTitle.textContent = r.name;
          elName.value = r.name || '';
          elTime.value = r.time_hm || '';
          elEnabled.value = String(r.enabled ? 1 : 0);
          openDlg(dlgD);
        };

        if (btnCloseD) btnCloseD.addEventListener('click', function(){ closeDlg(dlgD); });
      })();
    </script>
  </div>
  `;

  res.type('html').send(adminLayout({ title: 'จัดการเวลาส่ง', active: 'delivery', msg, body }));
});

app.post('/admin/delivery-time/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = ((req.body && req.body.name) || '').trim();
  const time_hm = ((req.body && req.body.time_hm) || '').trim();
  const enabled = String((req.body && req.body.enabled) ?? '1') === '0' ? 0 : 1;
  const day = req.body && req.body.day;
  const days = Array.isArray(day) ? day : (day !== undefined ? [day] : []);
  let mask = 0;
  for (const d of days) {
    const i = parseInt(d, 10);
    if (i >= 0 && i <= 6) mask |= (1 << i);
  }
  if (!mask) mask = 127;
  if (!name || !/^\d{2}:\d{2}$/.test(time_hm)) return redirectAdminTo(res, '/admin/delivery-times', 'กรอกชื่อและเวลาให้ถูกต้อง');

  const p = await db();
  await p.execute('INSERT INTO delivery_times(name,days_mask,time_hm,enabled) VALUES (?,?,?,?)', [name, mask, time_hm, enabled]);
  return redirectAdminTo(res, '/admin/delivery-times', 'เพิ่มรอบส่งแล้ว');
});

app.post('/admin/delivery-time/update', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number((req.body && req.body.id) || 0);
  const name = ((req.body && req.body.name) || '').trim();
  const time_hm = ((req.body && req.body.time_hm) || '').trim();
  const enabled = String((req.body && req.body.enabled) ?? '1') === '0' ? 0 : 1;
  const day = req.body && req.body.day;
  const days = Array.isArray(day) ? day : (day !== undefined ? [day] : []);
  let mask = 0;
  for (const d of days) {
    const i = parseInt(d, 10);
    if (i >= 0 && i <= 6) mask |= (1 << i);
  }
  if (!mask) mask = 127;
  if (!id || !name || !/^\d{2}:\d{2}$/.test(time_hm)) return redirectAdminTo(res, '/admin/delivery-times', 'ข้อมูลไม่ครบ');

  const p = await db();
  await p.execute('UPDATE delivery_times SET name=?, days_mask=?, time_hm=?, enabled=? WHERE id=?', [name, mask, time_hm, enabled, id]);
  return redirectAdminTo(res, '/admin/delivery-times', 'บันทึกแล้ว');
});

app.post('/admin/delivery-time/delete', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number((req.body && req.body.id) || 0);
  if (!id) return redirectAdminTo(res, '/admin/delivery-times', 'id หาย');
  const p = await db();
  await p.execute('DELETE FROM delivery_times WHERE id=?', [id]);
  return redirectAdminTo(res, '/admin/delivery-times', 'ลบแล้ว');
});



// SNIP: admin_guest_create_route.txt
app.post('/admin/guest/create', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const label = ((req.body && req.body.label) || '').trim();
  const note = ((req.body && req.body.note) || '').trim();
  const expiresDaysRaw = ((req.body && req.body.expires_days) || '').toString().trim();

  if (!label) return redirectAdminTo(res, '/admin', 'กรุณาใส่ชื่อที่แสดงของ guest');

  let expiresAt = null;
  if (expiresDaysRaw) {
    const d = Math.max(1, Math.min(365, parseInt(expiresDaysRaw, 10) || 0));
    if (d) {
      expiresAt = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
    }
  }

  const token = nanoid(12);
  const p = await db();
  await p.execute(
    'INSERT INTO guest_links(token,label,note,enabled,expires_at) VALUES (?,?,?,?,?)',
    [token, label, note, 1, expiresAt]
  );

  const link = `${BASE_URL}/g/${token}`;
  return redirectAdminTo(res, '/admin', `สร้างลิงก์ guest แล้ว: ${link}`);
});



// SNIP: admin_guest_quick_route.txt
app.post('/admin/guest/quick', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const token = nanoid(12);
    const label = `ลูกค้าใหม่ ${new Date().toLocaleString('th-TH')}`;
    const p = await db();
    await p.execute(
      'INSERT INTO guest_links(token,label,note,enabled,expires_at) VALUES (?,?,?,?,?)',
      [token, label, '', 1, null]
    );
    const link = `${BASE_URL}/g/${token}`;
    return res.json({ ok: true, token, link });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'สร้างลิงก์ไม่สำเร็จครับ' });
  }
});



// SNIP: admin_order_status_route.txt
app.post('/admin/order/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { orderId, status } = req.body || {};
  const allowed = new Set(['new', 'confirmed', 'sent', 'done', 'canceled']);
  if (!orderId) return res.status(400).json({ ok: false, error: 'orderId หายครับ' });
  if (!allowed.has(String(status))) return res.status(400).json({ ok: false, error: 'status ไม่ถูกต้องครับ' });

  const p = await db();
  await p.execute('UPDATE orders SET status=? WHERE order_id=?', [String(status), String(orderId)]);
  return res.json({ ok: true });
});



// SNIP: print_route.js.txt
app.get('/admin/order/print/:orderId', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { orderId } = req.params;
  const p = await db();

  const [orders] = await p.execute(
    `SELECT order_id, customer_label, guest_label, created_at, status,
            delivery_date, delivery_time_name, delivery_time_hm
     FROM orders
     WHERE order_id = ?
     LIMIT 1`,
    [orderId]
  );
  const o = orders[0];
  if (!o) return res.status(404).type('text').send('not found');

  const [items] = await p.execute(
    `SELECT name_snapshot, unit_snapshot, price_snapshot, qty
     FROM order_items
     WHERE order_id = ?
     ORDER BY id ASC`,
    [orderId]
  );

  const customer = o.customer_label || o.guest_label || 'ลูกค้า';
  const when = new Date(o.created_at).toLocaleString('th-TH');
  const total = items.reduce((s, it) => s + (Number(it.price_snapshot || 0) * Number(it.qty || 0)), 0);

  const html = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Print</title>
  <style>
    @page { size: A6; margin: 8mm; }
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto; font-size:12px;}
    .muted{color:#666}
    h1{font-size:14px;margin:0 0 6px}
    table{width:100%;border-collapse:collapse}
    td{padding:4px 0;vertical-align:top}
    .right{text-align:right}
    .line{border-top:1px dashed #bbb;margin:8px 0}
    .total{font-size:14px;font-weight:800}
  </style>
</head>
<body>
  <h1>veg</h1>
  <div><b>${escapeHtml(customer)}</b></div>
  <div class="muted">${escapeHtml(when)}</div>
  ${o.delivery_time_name ? `<div class="muted">ส่ง: ${escapeHtml(o.delivery_time_name)} ${escapeHtml(o.delivery_time_hm || '')}</div>` : ''}
  <div class="line"></div>

  <table>
    <tbody>
      ${items.map(it => {
        const lineTotal = Number(it.price_snapshot || 0) * Number(it.qty || 0);
        return `<tr>
          <td>${escapeHtml(it.name_snapshot)} <span class="muted">${escapeHtml(it.unit_snapshot || '')}</span><div class="muted">${escapeHtml(it.qty)} x ${escapeHtml(it.price_snapshot)}</div></td>
          <td class="right"><b>${escapeHtml(lineTotal.toLocaleString('th-TH'))}</b></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>

  <div class="line"></div>
  <div class="right total">รวม ${escapeHtml(total.toLocaleString('th-TH'))} บาท</div>

  <script>
    setTimeout(function(){ try{ window.print(); }catch(e){} }, 200);
  </script>
</body>
</html>`;

  res.type('html').send(html);
});



// SNIP: admin_customer_prices_routes.txt
app.get('/admin/customer-prices', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const customerToken = String(req.query.customerToken || '').trim();
  if (!customerToken) return redirectAdminTo(res, '/admin/customers', 'customerToken หาย');

  const customer = await getCustomerByToken(customerToken);
  if (!customer) return redirectAdminTo(res, '/admin/customers', 'ไม่พบลูกค้านี้');

  const p = await db();
  const [vegs] = await p.query('SELECT id,name,unit,price FROM veggies WHERE enabled=1 ORDER BY sort_order ASC, name ASC');
  const [over] = await p.execute('SELECT veg_id, price FROM customer_veg_prices WHERE customer_token=?', [customerToken]);
  const map = new Map(over.map(r => [r.veg_id, Number(r.price)]));
  const msg = req.query.msg ? String(req.query.msg) : '';

  const body = `
  <div class="card">
    <h2 style="margin:0 0 8px">ตั้งราคารายลูกค้า</h2>
    <div class="muted">ลูกค้า: <b>${escapeHtml(customer.label || customerToken)}</b></div>
    <div class="muted">ถ้าไม่กรอกราคา จะใช้ “ราคากลาง”</div>

    <div style="height:12px"></div>
    <form method="post" action="/admin/customer-prices/save?token=${escapeHtml(ADMIN_TOKEN)}">
      <input type="hidden" name="customerToken" value="${escapeHtml(customerToken)}" />

      <table>
        <thead>
          <tr>
            <th>ผัก</th>
            <th>ราคากลาง</th>
            <th>ราคาลูกค้า</th>
          </tr>
        </thead>
        <tbody>
          ${vegs.map(v => {
            const base = Number(v.price || 0);
            const cur = map.has(v.id) ? map.get(v.id) : '';
            return `
              <tr>
                <td><b>${escapeHtml(v.name)}</b> <span class="muted">${escapeHtml(v.unit || '')}</span></td>
                <td class="right">${escapeHtml(base.toLocaleString('th-TH'))}</td>
                <td>
                  <input name="price_${escapeHtml(v.id)}" type="number" step="0.01" placeholder="(ใช้ราคากลาง)" value="${cur === '' ? '' : escapeHtml(cur)}" />
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>

      <div style="height:12px"></div>
      <div class="actions" style="justify-content:flex-end">
        <button type="submit">บันทึก</button>
      </div>
    </form>
  </div>
  `;

  res.type('html').send(adminLayout({ title: 'ตั้งราคา', active: 'customers', msg, body }));
});

app.post('/admin/customer-prices/save', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const customerToken = String((req.body && req.body.customerToken) || '').trim();
  if (!customerToken) return redirectAdminTo(res, '/admin/customers', 'customerToken หาย');

  const p = await db();
  const [vegs] = await p.query('SELECT id FROM veggies WHERE enabled=1');

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();

    for (const v of vegs) {
      const key = 'price_' + v.id;
      const raw = (req.body && req.body[key])
        ? String(req.body[key]).trim()
        : '';
      if (!raw) {
        await conn.execute('DELETE FROM customer_veg_prices WHERE customer_token=? AND veg_id=?', [customerToken, v.id]);
      } else {
        const price = Number(raw);
        if (!Number.isFinite(price) || price < 0) continue;
        await conn.execute(
          'INSERT INTO customer_veg_prices(customer_token, veg_id, price) VALUES (?,?,?) ON DUPLICATE KEY UPDATE price=VALUES(price)',
          [customerToken, v.id, price]
        );
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error(e);
    return redirectAdminTo(res, '/admin/customers', 'บันทึกราคาไม่สำเร็จ');
  } finally {
    conn.release();
  }

  return redirectAdminTo(res, '/admin/customer-prices', 'บันทึกราคาแล้ว');
});



// TODO: rebuild remaining admin pages from /tmp snippets (customers/veggies/groups/delivery-times, print, status updates)

app.listen(PORT, () => {
  console.log(`veg-order-app listening on :${PORT}`);
});
