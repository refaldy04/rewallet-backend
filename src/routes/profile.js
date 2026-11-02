const profile = require('express').Router();
const profileController = require('../controllers/profile');
const { body } = require('express-validator');
const { asyncHandler } = require('../helpers/security');

const profileValidation = [
  body('fullname').optional().isString().isLength({ min: 1, max: 255 }),
  body('picture').optional().isURL(),
  body('user_id').isInt({ min: 1 }),
  body('phone_number').optional().isMobilePhone(['id-ID']),
];

profile.get('/profile', asyncHandler(profileController.getAllProfile));
profile.get('/profile/:id', asyncHandler(profileController.getProfileById));
profile.post('/profile', ...profileValidation, asyncHandler(profileController.createProfile));
profile.patch('/profile/:id', asyncHandler(profileController.editProfile));
profile.delete('/profile/:id', asyncHandler(profileController.deleteProfile));

module.exports = profile;
