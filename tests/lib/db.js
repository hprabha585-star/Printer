// Direct database access for tests (to set up situations like "paid 25 hours ago").
'use strict';
const mysql = require('mysql2/promise');
let pool;
const p = () => pool || (pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  timezone: 'Z', dateStrings: false, connectionLimit: 4,
}));
module.exports = {
  q: async (sql, params) => (await p().query(sql, params))[0],
  close: async () => { if (pool) { await pool.end(); pool = null; } },
};
