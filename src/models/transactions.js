const db = require('../helpers/db')

exports.getAllTransactions = (cb) => {
  db.query('SELECT * FROM transaction ORDER BY id ASC', (err, res) => {
    cb(res.rows)
  })
}

exports.getTransactionById = (id, cb) => {
  db.query('SELECT * FROM transaction WHERE id=$1', [id], (err, res) => {
    cb(err, res)
  })
}

exports.getTransactionUser = (id, limit, offset = 0, cb) => {
  db.query(
    `SELECT t.id, t.time, t.created_at, t.type_id, tt.code AS type_code,
            t.amount, t.currency, t.status, t.reference_id, t.notes,
            t.sender_id, t.recipient_id, p.picture, p.fullname,
            CASE WHEN t.recipient_id = $1 THEN 'CREDIT' ELSE 'DEBIT' END AS direction
     FROM public.transaction t
     LEFT JOIN public.transaction_type tt ON tt.id = t.type_id
     LEFT JOIN public.profile p ON p.user_id = CASE
       WHEN t.recipient_id = $1 THEN t.sender_id ELSE t.recipient_id END
     WHERE t.sender_id = $1 OR t.recipient_id = $1
     ORDER BY t.created_at DESC NULLS LAST, t.time DESC, t.id DESC
     LIMIT $2 OFFSET $3`,
    [id, limit, offset],
    (err, res) => {
      if (res) {
        cb(err, res.rows)
      } else {
        cb(err)
      }
    }
  )
}

exports.countAllTransaction = (id, cb) => {
  db.query('SELECT count(*)::integer AS count FROM public.transaction WHERE sender_id=$1 OR recipient_id=$1', [id], (err, res) => {
    cb(err, res?.rows[0].count)
  })
}

exports.createTransaction = (data, cb) => {
  const query = `INSERT INTO transaction(amount, sender_id, recipient_id, notes, time, type_id) VALUES($1, $2, $3, $4, $5, $6) RETURNING *`
  const val = [data.amount, data.sender_id, data.recipient_id, data.notes, data.time, data.type_id]
  db.query(query, val, (err, res) => {
    if (err) {
      // console.log(err);
      cb(err)
    } else {
      cb(err, res.rows)
    }
  })
}

exports.editTransaction = (id, data, cb) => {
  const query = 'UPDATE transaction SET amount=$1, recipient_id=$2, sender_id=$3, notes=$4, time=$5, type_id=$6 WHERE id=$7 RETURNING *'
  const value = [data.amount, data.recipient_id, data.sender_id, data.notes, data.time, data.type_id, id]
  db.query(query, value, (err, res) => {
    if (res) {
      // console.log(res);
      cb(err, res.rows)
    } else {
      cb(err)
    }
  })
}

exports.deleteTransaction = (id, cb) => {
  const query = 'DELETE FROM transaction WHERE id=$1 RETURNING *'
  const value = [id]
  db.query(query, value, (err, res) => {
    cb(res.rows)
  })
}
