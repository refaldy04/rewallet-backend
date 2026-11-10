const { httpError } = require('./security');

// A merchant-controlled catalogue, not a claim that Xendit activated these channels.
const channels = Object.freeze({
  DANA: { name: 'DANA', flow: 'REDIRECT', min: 100, max: 20000000 },
  SHOPEEPAY: { name: 'ShopeePay', flow: 'REDIRECT', min: 1, max: 20000000 },
  QRIS: { name: 'QRIS', flow: 'QR', min: 1, max: 10000000 },
});

function credentials() {
  const secretKey = process.env.XENDIT_SECRET_KEY?.trim();
  const webhookToken = process.env.XENDIT_WEBHOOK_TOKEN?.trim();
  const businessId = process.env.XENDIT_BUSINESS_ID?.trim();
  if (process.env.XENDIT_ENABLED !== 'true' || !secretKey || !webhookToken || !businessId) {
    throw httpError(503, 'Xendit top ups are not configured');
  }
  return { secretKey, webhookToken, businessId };
}

function returnUrl(value) {
  try {
    const url = new URL(value);
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw httpError(503, 'Configure valid Xendit frontend return URLs');
  }
}

function checkout() {
  const config = credentials();
  const enabled = [...new Set((process.env.XENDIT_ENABLED_CHANNELS || '').split(',').map((value) => value.trim()).filter(Boolean))];
  if (!enabled.length || enabled.some((code) => !Object.hasOwn(channels, code))) throw httpError(503, 'Configure supported Xendit channels');
  const min = Number(process.env.TOPUP_MIN_AMOUNT ?? '10000');
  const max = Number(process.env.TOPUP_MAX_AMOUNT ?? '10000000');
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min <= 0 || max < min) throw httpError(503, 'Configure valid top up limits');
  const methods = enabled.map((code) => ({ channel_code: code, name: channels[code].name, flow: channels[code].flow,
    currency: 'IDR', min_amount: String(Math.max(min, channels[code].min)), max_amount: String(Math.min(max, channels[code].max)) }))
    .filter((method) => BigInt(method.min_amount) <= BigInt(method.max_amount));
  if (!methods.length) throw httpError(503, 'No Xendit channels support the configured limits');
  if (methods.some((method) => method.flow === 'REDIRECT')) {
    config.successUrl = returnUrl(process.env.XENDIT_SUCCESS_RETURN_URL);
    config.failureUrl = returnUrl(process.env.XENDIT_FAILURE_RETURN_URL);
  }
  return { ...config, methods };
}

function properties(method, config, id) {
  if (method.flow !== 'REDIRECT') return {};
  const withId = (value) => { const url = new URL(value); url.searchParams.set('topup_id', id); return url.toString(); };
  return { success_return_url: withId(config.successUrl), failure_return_url: withId(config.failureUrl) };
}

module.exports = { credentials, checkout, properties };
