'use strict';
/**
 * Test runner: starts the app against a throwaway database on a spare port,
 * runs the HTTP suite against it, then shuts everything down.
 *
 *   npm test
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const DB = path.join(os.tmpdir(), `salon-test-${process.pid}.db`);
const PORT = process.env.TEST_PORT || '3399';

function removeDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch { /* nothing to remove */ }
  }
}

removeDb();

const server = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    PORT,
    SALON_DB: DB,
    SMS_DRIVER: 'log',
    // Drive the outbox worker fast so the suite can watch a message go out.
    SMS_TICK_MS: '300',
    SMS_REMINDER_TICK_MS: '10000',
    SESSION_SECRET: 'test-secret',
    ADMIN_PASSWORD: 'admin123',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.status === 200) return true;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function finish(code) {
  server.kill();
  removeDb();
  process.exit(code);
}

(async () => {
  if (!(await waitForServer())) {
    console.error('Server never became ready.\n' + serverLog);
    return finish(1);
  }

  const tests = spawn(process.execPath, [path.join(__dirname, 'e2e.js')], {
    env: { ...process.env, BASE: `http://127.0.0.1:${PORT}` },
    stdio: 'inherit',
  });

  tests.on('exit', (code) => {
    const sms = serverLog.split('\n').filter((l) => l.includes('[SMS ->'));
    if (sms.length) {
      console.log(`SMS messages sent during the run: ${sms.length}`);
      sms.slice(0, 3).forEach((l) => console.log('  ' + l.trim()));
    }
    // Any stack trace from the server means a route threw, even if a test passed.
    const crashes = serverLog.split('\n').filter((l) => /^\s+at |Error:/.test(l));
    if (crashes.length) {
      console.log('\n!! server logged errors — a route threw:');
      crashes.slice(0, 25).forEach((l) => console.log('  ' + l.trim()));
      return finish(1);
    }
    finish(code || 0);
  });
})();
