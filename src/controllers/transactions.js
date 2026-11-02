const response = require('../helpers/standardResponse');
const transactionModels = require('../models/transactions');
const { validationResult } = require('express-validator');
const errorResponse = require('../helpers/errorResponse');

exports.getAllTransaction = (req, res) => {
  transactionModels.getAllTransactions((result) => {
    return response(res, 'List all transaction', result);
  });
};

exports.getTransactionById = (req, res) => {
  const { id } = req.params;
  transactionModels.getTransactionById(id, (err, result) => {
    if (result.rows.length > 0) {
      return response(res, 'Detail transaction', result.rows[0]);
    } else {
      return res.redirect('/404');
    }
  });
};

exports.createTransaction = (req, res) => {
  const validation = validationResult(req);
  if (!validation.isEmpty()) {
    return response(res, 'Error occured', validation.array(), 400);
  }
  transactionModels.createTransaction(req.body, (err, result) => {
    if (err) {
      return errorResponse(err, res);
    } else {
      return response(res, 'Transaction created', result);
    }
  });
};

exports.editTransaction = (req, res) => {
  const { id } = req.params;
  transactionModels.editTransaction(id, req.body, (err, result) => {
    if (err) {
      return errorResponse(err, res);
    } else {
      return response(res, 'Edit transaction successfully', result[0]);
    }
  });
};

exports.deleteTransaction = (req, res) => {
  const { id } = req.params;
  transactionModels.deleteTransaction(id, (result) => {
    return response(res, 'Transaction deleted', result[0]);
  });
};
