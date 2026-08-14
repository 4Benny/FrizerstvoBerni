'use strict';

const session = require('express-session');
const { db } = require('./db');

/**
 * Minimal SQLite-backed session store so logins survive a server restart
 * without pulling in another dependency.
 */
class SqliteStore extends session.Store {
  constructor({ ttlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.sweep();
    // Drop expired rows once an hour; unref so it never holds the process open.
    this.timer = setInterval(() => this.sweep(), 60 * 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  sweep() {
    try {
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    } catch {
      /* a sweep failure must never take the server down */
    }
  }

  expiryFor(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    return Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      db.prepare(
        `INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data`
      ).run(sid, this.expiryFor(sess), JSON.stringify(sess));
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(
        this.expiryFor(sess),
        sid
      );
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }
}

module.exports = SqliteStore;
