const response = require('../helpers/standardResponse');

// public.users has no role column. Only the operator can set this allowlist.
module.exports = (req, res, next) => {
  const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map((id) => id.trim()).filter((id) => /^[1-9]\d*$/.test(id));
  if (!req.authUser || !adminIds.includes(String(req.authUser.id))) {
    return response(res, 'Administrator access required', null, null, 403);
  }
  next();
};
