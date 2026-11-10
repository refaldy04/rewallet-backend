const auth = require('express').Router();
const controller = require('../controllers/auth');
const profiles = require('../controllers/profile');
const topup = require('../controllers/topup');
const { body } = require('express-validator');
const authenticated = require('../middleware/auth');
const { asyncHandler } = require('../helpers/security');

const password = (field) => body(field).isString().bail().isLength({ min: 8 }).withMessage('Password must have at least eight characters').bail().custom((value) => Buffer.byteLength(value, 'utf8') <= 72).withMessage('Password must be at most 72 bytes');
const pin = (field) => body(field).isString().bail().isLength({ min: 6, max: 6 }).bail().matches(/^\d{6}$/).withMessage('PIN must contain exactly six digits');
const changePassword = [body('password').isString().notEmpty(), password('newpassword')];
const phone = body('phonenumber').isMobilePhone(['id-ID']).withMessage('Invalid Indonesian phone number');

auth.post('/register', body('email').isEmail(), body('username').isString().isLength({ min: 4, max: 255 }), password('password'), asyncHandler(controller.register));
auth.post('/login', body('email').isEmail(), body('password').isString().notEmpty(), asyncHandler(controller.login));
auth.post('/createPin', authenticated, pin('pin'), asyncHandler(controller.createPin));
auth.post('/checkPin', authenticated, pin('pin'), asyncHandler(controller.checkPin));
auth.patch('/changePin', authenticated, pin('pin'), pin('newpin'), asyncHandler(controller.changePin));
auth.get('/profile', authenticated, asyncHandler(controller.getUserData));
auth.get('/historyTransaction', authenticated, asyncHandler(controller.getUserTransaction));
auth.get('/allProfile', authenticated, asyncHandler(profiles.getRecipients));
auth.patch('/profile', authenticated, asyncHandler(controller.editProfile));
auth.patch('/changePassword', authenticated, ...changePassword, asyncHandler(controller.changePassword));
auth.patch('/resetPassword/:id', authenticated, ...changePassword, asyncHandler(controller.resetPassword));
auth.patch('/phone', authenticated, phone, asyncHandler(controller.changePhoneNumber));
auth.post('/phone', authenticated, phone, asyncHandler(controller.addPhoneNumber));
auth.post('/transfer', authenticated, pin('pin'), asyncHandler(controller.transfer));
auth.get('/topup/methods', authenticated, asyncHandler(topup.methods));
auth.post('/topup', authenticated, asyncHandler(topup.create));
auth.get('/topups/:id', authenticated, asyncHandler(topup.get));
auth.post('/topups/:id/refresh', authenticated, asyncHandler(topup.refresh));
auth.post('/checkEmail', controller.checkEmail);

module.exports = auth;
