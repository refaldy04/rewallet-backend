const { promisify } = require('node:util');
const response = require('../helpers/standardResponse');
const types = require('../models/transactionType');
const { httpError, integerId } = require('../helpers/security');

function editableFields(body, creating = false) {
  const fields = body || {};
  if (Object.keys(fields).some((field) => !['name', 'description'].includes(field))) throw httpError(400, 'Only name and description may be edited');
  if ((creating || fields.name !== undefined) && (typeof fields.name !== 'string' || !fields.name.trim() || fields.name.length > 100)) throw httpError(400, 'Invalid transaction type name');
  if (fields.description !== undefined && fields.description !== null && typeof fields.description !== 'string') throw httpError(400, 'Invalid transaction type description');
  return fields;
}

exports.getAllTransactionType = async (req, res) => {
  return response(res, 'Transaction types', await promisify(types.getAllTransactionsType)());
};

exports.getTransactionTypeById = async (req, res) => {
  const { rows } = await promisify(types.getTransactionTypeById)(integerId(req.params.id));
  if (!rows[0]) throw httpError(404, 'Transaction type not found');
  return response(res, 'Detail transaction type', rows[0]);
};

exports.createTransactionType = async (req, res) => {
  const row = await promisify(types.createTransactionType)(editableFields(req.body, true));
  return response(res, 'Transaction type created', row, null, 201);
};

exports.editTransactionType = async (req, res) => {
  const row = await promisify(types.editTransactionType)(integerId(req.params.id), editableFields(req.body));
  if (!row) throw httpError(404, 'Transaction type not found');
  return response(res, 'Transaction type updated', row);
};

exports.deleteTransactionType = async (req, res) => {
  let row;
  try {
    row = await promisify(types.deleteTransactionType)(integerId(req.params.id));
  } catch (err) {
    if (['23503', '23001'].includes(err.code)) throw httpError(409, 'Transaction type is still in use');
    throw err;
  }
  if (!row) throw httpError(404, 'Transaction type not found');
  return response(res, 'Transaction type deleted', row);
};
