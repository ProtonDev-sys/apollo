const { createHash, randomBytes, scryptSync, timingSafeEqual } = require('crypto');
const { createHttpError } = require('./http-error');

const DEFAULT_SESSION_TTL_HOURS = 168;
const MIN_SHARED_SECRET_LENGTH = 12;
const SESSION_TOKEN_BYTES = 32;
const SECRET_SALT_BYTES = 16;

function hashSessionToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function normaliseSessionTtlHours(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SESSION_TTL_HOURS;
  }

  return Math.min(24 * 30, Math.max(1, parsed));
}

function deriveSharedSecretHash(secret, salt) {
  return scryptSync(secret, salt, 64).toString('hex');
}

function createSharedSecretRecord(secret) {
  const trimmedSecret = String(secret || '').trim();
  if (trimmedSecret.length < MIN_SHARED_SECRET_LENGTH) {
    throw createHttpError(
      400,
      `API shared secret must be at least ${MIN_SHARED_SECRET_LENGTH} characters.`
    );
  }

  const salt = randomBytes(SECRET_SALT_BYTES).toString('hex');
  return {
    apiSharedSecretHash: deriveSharedSecretHash(trimmedSecret, salt),
    apiSharedSecretSalt: salt
  };
}

function verifySharedSecret(secret, settings) {
  const expectedHash = settings.apiSharedSecretHash || '';
  const salt = settings.apiSharedSecretSalt || '';
  if (!expectedHash || !salt) {
    return false;
  }

  const derivedHash = deriveSharedSecretHash(String(secret || '').trim(), salt);
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  const actualBuffer = Buffer.from(derivedHash, 'hex');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

class AuthService {
  constructor({ store }) {
    this.store = store;
    this.sessions = new Map();
  }

  clearExpiredSessions() {
    const now = Date.now();
    for (const [sessionHash, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionHash);
      }
    }
  }

  clearSessions() {
    this.sessions.clear();
  }

  getPublicStatus() {
    const settings = this.store.getSettings();
    return {
      enabled: Boolean(settings.apiAuthEnabled),
      configured: Boolean(settings.apiSharedSecretHash && settings.apiSharedSecretSalt),
      sessionTtlHours: normaliseSessionTtlHours(settings.apiSessionTtlHours)
    };
  }

  createSession({ secret }) {
    const settings = this.store.getSettings();
    if (!settings.apiAuthEnabled) {
      throw createHttpError(400, 'API authentication is disabled.');
    }

    if (!verifySharedSecret(secret, settings)) {
      throw createHttpError(401, 'Invalid API shared secret.');
    }

    this.clearExpiredSessions();

    const ttlHours = normaliseSessionTtlHours(settings.apiSessionTtlHours);
    const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const tokenHash = hashSessionToken(token);

    this.sessions.set(tokenHash, {
      expiresAt
    });

    return {
      token,
      tokenType: 'Bearer',
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  validateSessionToken(token) {
    const settings = this.store.getSettings();
    if (!settings.apiAuthEnabled) {
      return {
        ok: true,
        expiresAt: ''
      };
    }

    this.clearExpiredSessions();

    const tokenHash = hashSessionToken(token);
    const session = this.sessions.get(tokenHash);
    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(tokenHash);
      return null;
    }

    return {
      ok: true,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
  }

  revokeSession(token) {
    if (!token) {
      return {
        ok: true
      };
    }

    this.sessions.delete(hashSessionToken(token));
    return {
      ok: true
    };
  }
}

module.exports = {
  AuthService,
  DEFAULT_SESSION_TTL_HOURS,
  MIN_SHARED_SECRET_LENGTH,
  createSharedSecretRecord,
  normaliseSessionTtlHours
};
