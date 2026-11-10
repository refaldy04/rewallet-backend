const { promisify } = require('node:util');
const { validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const users = require('../models/users');
const profiles = require('../models/profile');
const transactions = require('../models/transactions');
const transfer = require('../services/transfer');
const pin = require('../helpers/pin');
const response = require('../helpers/standardResponse');
const { jwtSecret, credentialVersion, safeUser, validationErrors, httpError } = require('../helpers/security');
const upload = require('../helpers/cloudUpload').single('picture');

function validate(req, res) {
  const validation = validationResult(req);
  if (validation.isEmpty()) return true;
  response(res, 'Invalid input', validationErrors(validation), null, 400);
  return false;
}

exports.register = async (req, res) => {
  if (!validate(req, res)) return;
  const password = await bcrypt.hash(req.body.password, 12);
  const user = await users.registerUser({ email: req.body.email, username: req.body.username, password });
  return response(res, 'Registration successful. Log in to set your PIN', safeUser(user), null, 201);
};

exports.login = async (req, res) => {
  if (!validate(req, res)) return;
  const result = await promisify(users.getCredentialsByEmail)(req.body.email);
  const user = result.rows[0];
  if (!user || !await bcrypt.compare(req.body.password, user.password)) throw httpError(401, 'Email or password not matched');
  const token = jwt.sign({ id: user.id, credentialVersion: credentialVersion(user.password) }, jwtSecret(), { algorithm: 'HS256', expiresIn: '1h' });
  return response(res, 'Login success', { ...safeUser(user), token, pinSet: Boolean(user.pin_hash || user.pin) });
};

exports.createPin = async (req, res) => {
  if (!validate(req, res)) return;
  await pin.create(req.authUser.id, req.body.pin);
  return response(res, 'Create PIN success');
};

exports.checkPin = async (req, res) => {
  if (!validate(req, res)) return;
  await pin.verify(req.authUser.id, req.body.pin);
  return response(res, 'PIN valid');
};

exports.changePin = async (req, res) => {
  if (!validate(req, res)) return;
  await pin.change(req.authUser.id, req.body.pin, req.body.newpin);
  return response(res, 'Change PIN successful');
};

exports.getUserData = async (req, res) => {
  const result = await promisify(profiles.getProfileByUserId)(req.authUser.id);
  if (!result.rows[0]) throw httpError(404, 'Profile not found');
  return response(res, 'Detail user', result.rows[0]);
};

exports.getUserTransaction = async (req, res) => {
  const id = req.authUser.id;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = await promisify(transactions.getTransactionUser)(id, limit, (page - 1) * limit);
  const totalData = await promisify(transactions.countAllTransaction)(id);
  const totalPage = Math.ceil(totalData / limit);
  return response(res, 'Transaction history', result, { totalData, totalPage, currentPage: page, nextPage: page < totalPage ? page + 1 : null, prevPage: page > 1 ? page - 1 : null });
};

exports.editProfile = async (req, res) => {
  await new Promise((resolve, reject) => upload(req, res, (err) => err ? reject(httpError(400, 'Invalid profile upload')) : resolve()));
  const fields = req.body || {};
  if (Object.keys(fields).some((key) => !['fullname', 'phone_number'].includes(key))) throw httpError(400, 'Only fullname, phone_number and an uploaded picture may be edited');
  if (fields.fullname !== undefined && (typeof fields.fullname !== 'string' || !fields.fullname.trim() || fields.fullname.length > 255)) throw httpError(400, 'Invalid full name');
  if (fields.phone_number !== undefined && (typeof fields.phone_number !== 'string' || !/^\+?[0-9]{8,15}$/.test(fields.phone_number))) throw httpError(400, 'Invalid phone number');
  const result = await promisify(profiles.editOwnProfile)(req.authUser.id, fields, req.file?.filename);
  if (!result.length) throw httpError(404, 'Profile not found');
  return response(res, 'Edit profile successful', result);
};

exports.changePassword = async (req, res) => {
  // The old ID-only recovery endpoint is now a self-service, reauthenticated change.
  if (req.params.id !== undefined && req.params.id !== String(req.authUser.id)) throw httpError(403, 'You can only change your own password');
  if (!validate(req, res)) return;
  const { rows } = await promisify(users.getCredentialsById)(req.authUser.id);
  const user = rows[0];
  if (!user || !await bcrypt.compare(req.body.password, user.password)) throw httpError(401, 'Current password is incorrect');
  const password = await bcrypt.hash(req.body.newpassword, 12);
  const result = await promisify(users.changePassword)(user.id, user.password, password);
  if (!result) throw httpError(409, 'Password changed. Please log in again');
  return response(res, 'Password changed. Please log in again');
};
exports.resetPassword = exports.changePassword;

exports.changePhoneNumber = async (req, res) => {
  if (!validate(req, res)) return;
  const result = await promisify(profiles.changePhoneNumber)(req.authUser.id, { phonenumber: req.body.phonenumber });
  if (!result) throw httpError(404, 'Profile not found');
  return response(res, 'Phone number changed', result);
};
exports.addPhoneNumber = exports.changePhoneNumber;

exports.checkEmail = (req, res) => response(res, 'If the account exists, use the supported sign-in or recovery process');

exports.transfer = async (req, res) => {
  if (!validate(req, res)) return;
  const transaction = await transfer(req.authUser.id, req.body, req.get('Idempotency-Key'));
  return response(res, 'Transfer successful', transaction);
};
// Top ups require verified payment confirmation before any wallet credit.
