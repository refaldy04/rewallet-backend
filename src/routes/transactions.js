const transactions = require('express').Router();
const controller = require('../controllers/transactions');
const { asyncHandler } = require('../helpers/security');

// Generic admin CRUD bypasses the wallet/ledger transaction, even for an admin.
transactions.route('/transaction')
  .get(asyncHandler(controller.getAllTransaction))
  .all(controller.readOnly);
transactions.route('/transaction/:id')
  .get(asyncHandler(controller.getTransactionById))
  .all(controller.readOnly);

module.exports = transactions;
