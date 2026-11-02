require('dotenv').config();
require('./src/helpers/security').jwtSecret();

const express = require('express');
const authMiddleware = require('./src/middleware/auth');
var cors = require('cors');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/public', express.static('assets'));

// app.options('/products/:id', cors());
app.use(cors());

app.get('/', (req, res) => {
  return res.json({
    succes: true,
    message: 'This is Home Page :)',
  });
});

app.get('/authenticatedUser', authMiddleware, (req, res) => {
  const userModel = require('./src/models/users');
  userModel.getUserById(req.authUser.id, (err, result) => {
    if (err) return require('./src/helpers/errorResponse')(err, res);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, message: 'Authentication required' });
    return res.status(200).json({
      succes: true,
      message: `Hello ${user.email}`,
    });
  });
});

app.use('/', require('./src/routes'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
  return require('./src/helpers/errorResponse')(err, res);
});

app.use('*', (req, res) => {
  return res.status(404).json({
    success: false,
    message: 'Resource not found',
  });
});

module.exports = app;

if (require.main === module) {
  app.listen(process.env.PORT || 3334, () => {
    console.log(`App is running on port ${process.env.PORT || 3334}`);
  });
}
