// models/Settings.js
// Data access for the single "settings" row (owner pricing, UPI id, login
// credentials). Plain functions over a MySQL table -- there's only ever one
// row, keyed by settings_key = 'shop'.

const { pool } = require('../db');

function normalize(row) {
  if (!row) return null;
  return {
    key: row.settings_key,
    shopName: row.shopName,
    bw_price_per_page: Number(row.bw_price_per_page),
    color_price_per_page: Number(row.color_price_per_page),
    owner_upi_id: row.owner_upi_id,
    owner_display_name: row.owner_display_name,
    acceptingOrders: !!row.acceptingOrders,
    ownerUsername: row.ownerUsername || 'owner',
    ownerPassword: row.ownerPassword,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Ensures a settings row always exists, and returns it.
async function getOrCreate() {
  const [rows] = await pool.query('SELECT * FROM settings WHERE settings_key = ? LIMIT 1', ['shop']);
  if (rows.length) return normalize(rows[0]);

  await pool.query('INSERT INTO settings (settings_key) VALUES (?)', ['shop']);
  const [created] = await pool.query('SELECT * FROM settings WHERE settings_key = ? LIMIT 1', ['shop']);
  return normalize(created[0]);
}

// Partial update -- only fields present in `fields` are changed.
async function update(fields) {
  await getOrCreate(); // make sure the row exists first

  const allowed = [
    'shopName',
    'bw_price_per_page',
    'color_price_per_page',
    'owner_upi_id',
    'owner_display_name',
    'acceptingOrders',
    'ownerUsername',
    'ownerPassword',
  ];
  const sets = [];
  const values = [];
  for (const field of allowed) {
    if (fields[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(field === 'acceptingOrders' ? (fields[field] ? 1 : 0) : fields[field]);
    }
  }
  if (sets.length === 0) return getOrCreate();

  values.push('shop');
  await pool.query(`UPDATE settings SET ${sets.join(', ')} WHERE settings_key = ?`, values);
  return getOrCreate();
}

module.exports = { getOrCreate, update };
