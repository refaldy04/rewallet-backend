const topup = require('../services/topup');
const response = require('../helpers/standardResponse');

exports.methods = (req, res) => response(res, 'Enabled top up payment methods', topup.methods());
exports.create = async (req, res) => {
  const { payment, replayed } = await topup.create(req.authUser.id, req.body, req.get('Idempotency-Key'));
  const uncertain = ['CREATED', 'UNKNOWN'].includes(payment.status);
  return response(res, uncertain ? 'Top up awaiting payment confirmation; reuse the same idempotency key' : 'Top up payment request',
    payment, null, uncertain ? 202 : replayed ? 200 : 201);
};
exports.get = async (req, res) => response(res, 'Top up status', await topup.get(req.authUser.id, req.params.id));
exports.refresh = async (req, res) => response(res, 'Top up status refreshed', await topup.refresh(req.authUser.id, req.params.id));
exports.webhook = async (req, res) => response(res, 'Payment webhook received', await topup.webhook(req.get('x-callback-token'), req.body));
