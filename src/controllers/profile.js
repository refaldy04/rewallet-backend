const { promisify } = require('node:util');
const { validationResult } = require('express-validator');
const response = require('../helpers/standardResponse');
const profiles = require('../models/profile');
const { httpError, validationErrors } = require('../helpers/security');
const upload = require('../helpers/cloudUpload').single('picture');

async function list(req, res, privateFields) {
  const { search = '' } = req.query;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const result = await new Promise((resolve, reject) => profiles.getAllProfile(req.authUser.id, limit, search, (page - 1) * limit, req.query.sort === '1' ? 'DESC' : 'ASC', (err, rows) => err ? reject(err) : resolve(rows), privateFields));
  const totalData = await promisify(profiles.countAllProfile)(req.authUser.id, search);
  return response(res, 'Profile directory', result, { totalData, totalPage: Math.ceil(totalData / limit), currentPage: page });
}
exports.getAllProfile = (req, res) => list(req, res, true);
exports.getRecipients = (req, res) => list(req, res, false);
exports.getProfileById = async (req, res) => {
  const { rows } = await promisify(profiles.getProfileById)(req.params.id);
  if (!rows[0]) throw httpError(404, 'Profile not found');
  return response(res, 'Detail profile', rows[0]);
};
exports.createProfile = async (req, res) => {
  const validation = validationResult(req);
  if (!validation.isEmpty()) return response(res, 'Invalid input', validationErrors(validation), null, 400);
  if (req.body.balance !== undefined) throw httpError(400, 'Balance cannot be set through profile creation');
  return response(res, 'Profile created', await promisify(profiles.createProfile)(req.body), null, 201);
};
exports.editProfile = async (req, res) => {
  await new Promise((resolve, reject) => upload(req, res, (err) => err ? reject(httpError(400, 'Invalid profile upload')) : resolve()));
  if (Object.keys(req.body).some((key) => !['fullname', 'phone_number'].includes(key))) throw httpError(400, 'Only fullname, phone_number and an uploaded picture may be edited');
  const result = await promisify(profiles.editProfile)(req.params.id, req.body, req.file?.filename);
  if (!result.length) throw httpError(404, 'Profile not found');
  return response(res, 'Profile updated', result);
};
exports.deleteProfile = async (req, res) => {
  const result = await promisify(profiles.deleteProfile)(req.params.id);
  if (!result) throw httpError(404, 'Profile not found');
  return response(res, 'Profile deleted', result);
};
