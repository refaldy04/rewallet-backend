const transactionsType = require('express').Router();
const transactionsTypeController = require('../controllers/transactionType');
const { asyncHandler } = require('../helpers/security');

transactionsType.get('/transactionType', asyncHandler(transactionsTypeController.getAllTransactionType));
transactionsType.get('/transactionType/:id', asyncHandler(transactionsTypeController.getTransactionTypeById));
transactionsType.post('/transactionType', asyncHandler(transactionsTypeController.createTransactionType));
transactionsType.patch('/transactionType/:id', asyncHandler(transactionsTypeController.editTransactionType));
transactionsType.delete('/transactionType/:id', asyncHandler(transactionsTypeController.deleteTransactionType));

module.exports = transactionsType;
