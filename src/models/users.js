const db = require('../helpers/db');
const { httpError } = require('../helpers/security');

const publicColumns = 'id, email, username';
const credentials = 'id, email, username, password, pin, pin_hash';

exports.getAllUsers = (keyword, limit, offset, sortBy, sort, cb) => {
  const column = ['id', 'email', 'username'].includes(sortBy) ? sortBy : 'id';
  const direction = sort === 'DESC' ? 'DESC' : 'ASC';
  db.query(`SELECT ${publicColumns} FROM public.users WHERE email ILIKE $1 ORDER BY ${column} ${direction} LIMIT $2 OFFSET $3`, [`%${keyword}%`, limit, offset], (err, result) => cb(err, result?.rows));
};

exports.getUserById = (id, cb) => db.query(`SELECT ${publicColumns} FROM public.users WHERE id=$1`, [id], cb);
exports.getCredentialsById = (id, cb) => db.query(`SELECT ${credentials} FROM public.users WHERE id=$1`, [id], cb);
exports.getCredentialsByEmail = (email, cb) => db.query(`SELECT ${credentials} FROM public.users WHERE email=$1`, [email], cb);

exports.countAllUsers = (keyword, cb) => {
  db.query('SELECT count(*)::integer AS count FROM public.users WHERE email ILIKE $1', [`%${keyword}%`], (err, result) => cb(err, result?.rows[0].count));
};

exports.createUsers = (data, cb) => {
  // Admin-created accounts use the same atomic setup as public registration.
  exports.registerUser(data).then((user) => cb(null, [user]), cb);
};

exports.registerUser = async (data) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO public.users(email, password, username) VALUES($1, $2, $3) RETURNING ${publicColumns}`, [data.email, data.password, data.username]);
    const user = result.rows[0];
    await client.query('INSERT INTO public.profile(user_id) VALUES($1)', [user.id]);
    await client.query('INSERT INTO public.wallets(user_id) VALUES($1)', [user.id]);
    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

exports.updateUser = (id, data, cb) => {
  const entries = Object.entries({ email: data.email, username: data.username, password: data.password }).filter(([, value]) => value !== undefined);
  if (!entries.length) return cb(httpError(400, 'No editable fields supplied'));
  const assignments = entries.map(([key], index) => `${key}=$${index + 2}`).join(', ');
  db.query(`UPDATE public.users SET ${assignments} WHERE id=$1 RETURNING ${publicColumns}`, [id, ...entries.map(([, value]) => value)], (err, result) => cb(err, result?.rows[0]));
};

exports.changePassword = (id, oldHash, newHash, cb) => {
  // A concurrent change must not be overwritten using stale credentials.
  db.query(`UPDATE public.users SET password=$3 WHERE id=$1 AND password=$2 RETURNING ${publicColumns}`, [id, oldHash, newHash], (err, result) => cb(err, result?.rows[0]));
};

exports.deleteUser = (id, cb) => db.query(`DELETE FROM public.users WHERE id=$1 RETURNING ${publicColumns}`, [id], (err, result) => cb(err, result?.rows[0]));
