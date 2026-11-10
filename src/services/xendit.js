const { credentials } = require('../helpers/xenditConfig');

class XenditError extends Error {
  constructor(code, definitive = false) {
    super('Xendit request could not be completed');
    this.code = code;
    this.definitive = definitive;
    this.status = 502;
    this.expose = true;
  }
}

function failureCode(value, fallback = 'XENDIT_ERROR') {
  return typeof value === 'string' && /^[A-Z0-9_]{1,100}$/.test(value) ? value : fallback;
}

async function request(method, resource, body) {
  const { secretKey } = credentials();
  // Only server-generated resource paths reach this adapter. Never follow a redirect with credentials.
  if (!/^\/(?:payment_requests|payments)(?:\/[a-zA-Z0-9_-]{1,255})?$/.test(resource)) throw new Error('Invalid Xendit resource');
  try {
    const response = await fetch(`https://api.xendit.co/v3${resource}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
        'api-version': '2024-11-11', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let data;
    try { if (raw.length <= 1024 * 1024) data = JSON.parse(raw); } catch { /* Redact non-JSON provider responses. */ }
    if (!response.ok) {
      // A timeout/conflict/rate limit or server error can leave the creation outcome uncertain.
      const definitive = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status);
      throw new XenditError(failureCode(data?.error_code, 'XENDIT_HTTP_ERROR'), definitive);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new XenditError('INVALID_XENDIT_RESPONSE');
    return data;
  } catch (err) {
    if (err instanceof XenditError) throw err;
    // Never log/return an upstream body, fetch error or Authorization header.
    throw new XenditError('XENDIT_OUTCOME_UNKNOWN');
  }
}

module.exports = { request, failureCode, XenditError };
