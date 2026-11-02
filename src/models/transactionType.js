const db = require('../helpers/db');

exports.getAllTransactionsType = (cb) => {
  db.query('SELECT * FROM transaction_type ORDER BY id ASC', (err, res) => {
    cb(res.rows);
  });
};

exports.getTransactionTypeById = (id, cb) => {
  db.query('SELECT * FROM transaction_type WHERE id=$1', [id], (err, res) => {
    cb(err, res);
  });
};

exports.createTransactionType = (data, cb) => {
  const query = 'INSERT INTO transaction_type(name, description) VALUES($1, $2) RETURNING *';
  const values = [data.name, data.description];
  db.query(query, values, (err, res) => {
    if (err) {
      cb(err);
    } else {
      cb(err, res.rows);
    }
  });
};

exports.editTransactionType = (id, data, cb) => {
  const query = 'UPDATE transaction_type SET name=$1, description=$2 WHERE id=$3 RETURNING *';
  const value = [data.name, data.description, id];
  db.query(query, value, (err, res) => {
    if (res) {
      // console.log(res);
      cb(err, res.rows);
    } else {
      cb(err);
    }
  });
};

exports.deleteTransactionType = (id, cb) => {
  const query = 'DELETE FROM transaction_type WHERE id=$1 RETURNING *';
  const value = [id];
  db.query(query, value, (err, res) => {
    cb(res.rows);
  });
};
