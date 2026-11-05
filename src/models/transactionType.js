const db = require('../helpers/db');
const { httpError } = require('../helpers/security');

exports.getAllTransactionsType = (cb) => {
  db.query('SELECT * FROM public.transaction_type ORDER BY id ASC', (err, result) => cb(err, result?.rows));
};

exports.getTransactionTypeById = (id, cb) => {
  db.query('SELECT * FROM public.transaction_type WHERE id=$1', [id], cb);
};

exports.createTransactionType = (data, cb) => {
  db.query('INSERT INTO public.transaction_type(name, description) VALUES($1, $2) RETURNING *',
    [data.name, data.description ?? null], (err, result) => cb(err, result?.rows[0]));
};

exports.editTransactionType = (id, data, cb) => {
  const fields = Object.entries({ name: data.name, description: data.description }).filter(([, value]) => value !== undefined);
  if (!fields.length) return cb(httpError(400, 'No editable fields supplied'));
  const assignments = fields.map(([field], index) => `${field}=$${index + 2}`).join(', ');
  db.query(`UPDATE public.transaction_type SET ${assignments} WHERE id=$1 RETURNING *`,
    [id, ...fields.map(([, value]) => value)], (err, result) => cb(err, result?.rows[0]));
};

exports.deleteTransactionType = (id, cb) => {
  db.query('DELETE FROM public.transaction_type WHERE id=$1 RETURNING *', [id],
    (err, result) => cb(err, result?.rows[0]));
};
