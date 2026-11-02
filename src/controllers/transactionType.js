const response = require('../helpers/standardResponse');
const transactionTypeModels = require('../models/transactionType');
const errorResponse = require('../helpers/errorResponse');

exports.getAllTransactionType = (req, res) => {
  transactionTypeModels.getAllTransactionsType((result) => {
    return response(res, 'message from standard response: request success', result);
  });
};

exports.getTransactionTypeById = (req, res) => {
  const { id } = req.params;
  transactionTypeModels.getTransactionTypeById(id, (err, result) => {
    if (result.rows.length > 0) {
      return response(res, 'Detail transaction', result.rows[0]);
    } else {
      return res.redirect('/404');
    }
  });
};

exports.createTransactionType = (req, res) => {
  transactionTypeModels.createTransactionType(req.body, (err, result) => {
    if (err) {
      return errorResponse(err, res);
    } else {
      return response(res, 'Transaction created', result);
    }
  });
};

exports.editTransactionType = (req, res) => {
  const { id } = req.params;
  transactionTypeModels.editTransactionType(id, req.body, (err, result) => {
    if (err) {
      return errorResponse(err, res);
    } else {
      return response(res, 'Edit transaction type successfully', result[0]);
    }
  });
};

exports.deleteTransactionType = (req, res) => {
  const { id } = req.params;
  transactionTypeModels.deleteTransactionType(id, (result) => {
    return response(res, 'Transaction Type deleted', result[0]);
  });
};
