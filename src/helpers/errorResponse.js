const response = require('./standardResponse');

module.exports = (err, res) => {
  // Database details may contain submitted credentials; never log/return them.
  if (err.code === '23505') return response(res, 'Email or username already exists', null, null, 409);
  if (err.code === '23503') return response(res, 'Related record does not exist or is still in use', null, null, 400);
  if (['23502', '23514', '22P02', '22003'].includes(err.code)) return response(res, 'Invalid data', null, null, 400);
  if (err.status) return response(res, err.expose ? err.message : 'Invalid request', null, null, err.status);
  return response(res, 'Internal server error', null, null, 500);
};
