const jwt = require('jsonwebtoken');
const users = require('../models/users');
const response = require('../helpers/standardResponse');
const { jwtSecret, credentialVersion } = require('../helpers/security');

module.exports = (req, res, next) => {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) return response(res, 'Authentication required', null, null, 401);
  let claims;
  try {
    claims = jwt.verify(match[1], jwtSecret(), { algorithms: ['HS256'] });
    if (!Number.isSafeInteger(claims.id) || claims.id <= 0 || !Number.isFinite(claims.exp)) {
      return response(res, 'Invalid token', null, null, 401);
    }
  } catch {
    return response(res, 'Invalid or expired token', null, null, 401);
  }
  users.getCredentialsById(claims.id, (err, result) => {
    if (err) return next(err);
    const user = result.rows[0];
    if (!user || claims.credentialVersion !== credentialVersion(user.password)) {
      return response(res, 'Invalid or expired token', null, null, 401);
    }
    req.authUser = { id: user.id };
    next();
  });
};
