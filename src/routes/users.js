const users = require('express').Router();
const controller = require('../controllers/users');
const { body } = require('express-validator');
const { asyncHandler } = require('../helpers/security');

const validation = (optional) => {
  const field = (name) => optional ? body(name).optional() : body(name);
  return [field('email').isEmail(), field('username').isString().isLength({ min: 4, max: 255 }), field('password').isString().bail().isLength({ min: 8 }).bail().custom((value) => Buffer.byteLength(value, 'utf8') <= 72)];
};
users.get('/user', asyncHandler(controller.getAllUsers));
users.get('/user/:id', asyncHandler(controller.getUserById));
users.post('/user', ...validation(false), asyncHandler(controller.creatUsers));
users.patch('/user/:id', ...validation(true), asyncHandler(controller.editUser));
users.delete('/user/:id', asyncHandler(controller.deleteUser));
module.exports = users;
