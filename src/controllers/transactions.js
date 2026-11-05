const { promisify } = require('node:util');
const response = require('../helpers/standardResponse');
const transactions = require('../models/transactions');
const { httpError, integerId } = require('../helpers/security');

exports.getAllTransaction = async (req, res) => {
  return response(res, 'List all transactions', await promisify(transactions.getAllTransactions)());
};

exports.getTransactionById = async (req, res) => {
  const { rows } = await promisify(transactions.getTransactionById)(integerId(req.params.id));
  if (!rows[0]) throw httpError(404, 'Transaction not found');
  return response(res, 'Detail transaction', rows[0]);
};

exports.readOnly = (req, res) => {
  res.set('Allow', 'GET, HEAD');
  return response(res, 'Financial transactions are read-only. Use the wallet service for financial operations', null, null, 405);
};
