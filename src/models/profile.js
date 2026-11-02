const db = require('../helpers/db');
const { httpError } = require('../helpers/security');

exports.getAllProfile = (id, limit, search, offset, sort, cb, privateFields = false) => {
  const columns = privateFields ? '*' : 'id, user_id, fullname, picture';
  const direction = sort === 'DESC' ? 'DESC' : 'ASC';
  db.query(`SELECT ${columns} FROM public.profile WHERE user_id <> $1 AND fullname ILIKE $2 ORDER BY fullname ${direction} LIMIT $3 OFFSET $4`, [id, `%${search}%`, limit, offset], (err, result) => cb(err, result?.rows));
};

exports.countAllProfile = (id, search, cb) => db.query('SELECT count(*)::integer AS count FROM public.profile WHERE user_id <> $1 AND fullname ILIKE $2', [id, `%${search}%`], (err, result) => cb(err, result?.rows[0].count));
exports.getProfileById = (id, cb) => db.query('SELECT * FROM public.profile WHERE id=$1', [id], cb);
exports.getProfileByUserId = (id, cb) => db.query('SELECT * FROM public.profile WHERE user_id=$1', [id], cb);

exports.createProfile = (data, cb) => {
  db.query('INSERT INTO public.profile(fullname, picture, user_id, phone_number) VALUES($1, $2, $3, $4) RETURNING *', [data.fullname, data.picture, data.user_id, data.phone_number], (err, result) => cb(err, result?.rows));
};

function edit(column, id, data, picture, cb) {
  // Identity and balance are never writable through profile editing.
  const entries = Object.entries({ fullname: data.fullname, phone_number: data.phone_number, picture: picture ?? undefined }).filter(([, value]) => value !== undefined);
  if (!entries.length) return cb(httpError(400, 'No editable profile fields supplied'));
  const assignments = entries.map(([key], index) => `${key}=$${index + 2}`).join(', ');
  db.query(`UPDATE public.profile SET ${assignments} WHERE ${column}=$1 RETURNING *`, [id, ...entries.map(([, value]) => value)], (err, result) => cb(err, result?.rows));
}

exports.editProfile = (id, data, picture, cb) => edit('id', id, data, picture, cb);
exports.editOwnProfile = (userId, data, picture, cb) => edit('user_id', userId, data, picture, cb);
exports.changePhoneNumber = (id, data, cb) => db.query('UPDATE public.profile SET phone_number=$2 WHERE user_id=$1 RETURNING phone_number', [id, data.phonenumber], (err, result) => cb(err, result?.rows[0]));
exports.deleteProfile = (id, cb) => db.query('DELETE FROM public.profile WHERE id=$1 RETURNING *', [id], (err, result) => cb(err, result?.rows[0]));
