const { createHash } = require('node:crypto');

exports.jwtSecret = () => {
  const secret = process.env.APP_SECRET;
  if (!secret || !secret.trim()) throw new Error('APP_SECRET must be configured');
  return secret;
};

// Bind sessions to the current password hash, so password changes revoke old JWTs.
exports.credentialVersion = (passwordHash) => createHash('sha256').update(passwordHash).digest('hex');
exports.httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });
exports.safeUser = (user) => user && ({ id: user.id, email: user.email, username: user.username });

// express-validator includes submitted values by default, including credentials.
exports.validationErrors = (validation) => validation.array().map(({ msg, param, location }) => ({ msg, param, location }));
exports.asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Zero is supported for legacy transaction type IDs.
exports.integerId = (value) => {
  if (typeof value !== 'string' || !/^[0-9]{1,10}$/.test(value) || Number(value) > 2147483647) {
    throw exports.httpError(400, 'Invalid record ID');
  }
  return Number(value);
};
