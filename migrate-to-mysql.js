const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const DB_NAME = process.env.DB_NAME || 'veg_order';

if (!DB_USER) {
  console.error('Missing DB_USER env');
  process.exit(1);
}

async function main() {
  const dataDir = path.resolve(__dirname, 'data');
  const veggiesPath = path.join(dataDir, 'veggies.json');
  const customersPath = path.join(dataDir, 'customers.json');
  const ordersPath = path.join(dataDir, 'orders.jsonl');

  const conn = await mysql.createConnection({ host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME, multipleStatements: true });
  await conn.query('SET NAMES utf8mb4');

  // upsert customers
  const customers = JSON.parse(await fsp.readFile(customersPath, 'utf8'));
  for (const [token, c] of Object.entries(customers)) {
    const label = c.label || token;
    const note = c.note || '';
    const enabled = c.enabled === false ? 0 : 1;
    await conn.execute(
      'INSERT INTO customers(token,label,note,enabled) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label), note=VALUES(note), enabled=VALUES(enabled)',
      [token, label, note, enabled]
    );
  }

  // upsert veggies
  const veggies = JSON.parse(await fsp.readFile(veggiesPath, 'utf8'));
  let sort = 0;
  for (const v of veggies) {
    sort += 1;
    await conn.execute(
      'INSERT INTO veggies(id,name,unit,price,enabled,sort_order) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), unit=VALUES(unit), price=VALUES(price), enabled=VALUES(enabled), sort_order=VALUES(sort_order)',
      [v.id, v.name, v.unit || '', Number(v.price || 0), 1, sort]
    );
  }

  // migrate orders
  if (fs.existsSync(ordersPath)) {
    const raw = await fsp.readFile(ordersPath, 'utf8');
    const lines = raw.split(/\n/).filter(Boolean);
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o.orderId) continue;

      // ensure customer exists
      await conn.execute(
        'INSERT IGNORE INTO customers(token,label,note,enabled) VALUES (?,?,?,?)',
        [o.customerToken, o.customerLabel || o.customerToken, '', 1]
      );

      // insert order
      await conn.execute(
        'INSERT IGNORE INTO orders(order_id, customer_token, customer_label, created_at, user_agent) VALUES (?,?,?,?,?)',
        [o.orderId, o.customerToken, o.customerLabel || o.customerToken, new Date(o.createdAt), o.userAgent || '']
      );

      // items
      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        await conn.execute(
          'INSERT INTO order_items(order_id, veg_id, name_snapshot, unit_snapshot, qty) VALUES (?,?,?,?,?)',
          [o.orderId, it.vegId, it.name || it.vegId, it.unit || '', Number(it.qty || 0)]
        );
      }
    }
  }

  await conn.end();
  console.log('Migration completed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
