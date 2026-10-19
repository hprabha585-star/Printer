// Starts the PHP site on PHP's built-in web server for tests.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const SITE = path.join(__dirname, '..', '..', 'public_html');
const ROUTER = path.join(__dirname, '..', 'router.php');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function start(extraEnv = {}) {
  const port = extraEnv.PORT && extraEnv.PORT !== 0 ? Number(extraEnv.PORT) : await freePort();
  const env = { ...process.env, APP_ENV: 'test', PHP_CLI_SERVER_WORKERS: '6', ...extraEnv };
  delete env.PORT;
  const child = spawn('php', ['-d', 'upload_max_filesize=30M', '-d', 'post_max_size=32M', '-d', 'memory_limit=512M',
    '-d', 'display_errors=0', '-d', 'log_errors=1', '-S', `127.0.0.1:${port}`, '-t', SITE, ROUTER], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.log = '';
  child.stderr.on('data', (d) => { child.log = (child.log + d).slice(-20000); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/index.html'); break; } catch (_) { await new Promise((r) => setTimeout(r, 150)); }
  }
  child.base = base;
  child.port = port;
  return child;
}

module.exports = { start, SITE };
