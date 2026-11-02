const { promisify } = require('node:util');
const bcrypt = require('bcrypt');
const { validationResult } = require('express-validator');
const response = require('../helpers/standardResponse');
const users = require('../models/users');
const { validationErrors, httpError } = require('../helpers/security');

exports.getAllUsers = async (req, res) => {
  const { search = '', sortBy = 'id' } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = await promisify(users.getAllUsers)(search, limit, (page - 1) * limit, sortBy, req.query.sort === '1' ? 'DESC' : 'ASC');
  const totalData = await promisify(users.countAllUsers)(search);
  return response(res, 'List all users', result, { totalData, totalPage: Math.ceil(totalData / limit), currentPage: page });
};
exports.getUserById = async (req, res) => {
  const result = await promisify(users.getUserById)(req.params.id);
  if (!result.rows[0]) throw httpError(404, 'User not found');
  return response(res, 'Detail user', result.rows[0]);
};

async function save(req, res, create) {
  const validation = validationResult(req);
  if (!validation.isEmpty()) return response(res, 'Invalid input', validationErrors(validation), null, 400);
  if (Object.keys(req.body).some((field) => !['email', 'username', 'password'].includes(field))) throw httpError(400, 'Only email, username and password may be edited');
  const data = { ...req.body };
  if (data.password !== undefined) data.password = await bcrypt.hash(data.password, 12);
  const result = create ? (await promisify(users.createUsers)(data))[0] : await promisify(users.updateUser)(req.params.id, data);
  if (!result) throw httpError(404, 'User not found');
  return response(res, create ? 'User created' : 'User updated', result, null, create ? 201 : 200);
}
exports.creatUsers = (req, res) => save(req, res, true);
exports.editUser = (req, res) => save(req, res, false);
exports.deleteUser = async (req, res) => {
  const user = await promisify(users.deleteUser)(req.params.id);
  if (!user) throw httpError(404, 'User not found');
  return response(res, 'User deleted', user);
};
