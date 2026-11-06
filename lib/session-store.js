'use strict';

const session = require('express-session');

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;

/** Speichert Sitzungen in der zentralen Steuerungsdatenbank, nicht in Datenbanken der Organisationen. */
class DatabaseSessionStore extends session.Store {
  constructor(database) {
    super();
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_sessions_expires_at ON app_sessions(expires_at);
    `);
    this.readSession = database.prepare('SELECT data FROM app_sessions WHERE sid=? AND expires_at>?');
    this.writeSession = database.prepare('INSERT INTO app_sessions(sid,data,expires_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at');
    this.touchSession = database.prepare('UPDATE app_sessions SET expires_at=? WHERE sid=?');
    this.deleteSession = database.prepare('DELETE FROM app_sessions WHERE sid=?');
    this.deleteExpired = database.prepare('DELETE FROM app_sessions WHERE expires_at<=?');
    this.deleteAll = database.prepare('DELETE FROM app_sessions');
    this.countSessions = database.prepare('SELECT COUNT(*) count FROM app_sessions WHERE expires_at>?');
    this.listSessions = database.prepare('SELECT data FROM app_sessions WHERE expires_at>?');
    this.deleteForUser = database.prepare("DELETE FROM app_sessions WHERE json_extract(data,'$.user.tenant')=? AND json_extract(data,'$.user.id')=? AND sid<>?");
    this.deleteForTenant = database.prepare("DELETE FROM app_sessions WHERE json_extract(data,'$.user.tenant')=?");
  }

  expiresAt(sessionData) {
    const configured = sessionData?.cookie?.expires ? new Date(sessionData.cookie.expires).getTime() : NaN;
    return Number.isFinite(configured) ? configured : Date.now() + SESSION_MAX_AGE_MS;
  }

  get(sid, callback) {
    try {
      this.deleteExpired.run(Date.now());
      const row = this.readSession.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      this.deleteExpired.run(Date.now());
      this.writeSession.run(sid, JSON.stringify(sessionData), this.expiresAt(sessionData));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      this.touchSession.run(this.expiresAt(sessionData), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.deleteSession.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clear(callback = () => {}) {
    try {
      this.deleteAll.run();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  length(callback) {
    try {
      callback(null, this.countSessions.get(Date.now()).count);
    } catch (error) {
      callback(error);
    }
  }

  all(callback) {
    try {
      this.deleteExpired.run(Date.now());
      callback(null, this.listSessions.all(Date.now()).map(row => JSON.parse(row.data)));
    } catch (error) {
      callback(error);
    }
  }

  /** Beendet alle anderen Sitzungen einer Person, z. B. nach einer Passwortänderung. */
  revokeForUser(tenantSlug, userId, exceptSid = '') {
    return this.deleteForUser.run(tenantSlug, userId, exceptSid).changes;
  }

  revokeForTenant(tenantSlug) {
    return this.deleteForTenant.run(tenantSlug).changes;
  }
}

module.exports = { DatabaseSessionStore, SESSION_MAX_AGE_MS };
