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
    'SELECT transaction.id, transaction.time, transaction.type_id, transaction.amount, profile.picture, profile.fullname FROM transaction INNER JOIN profile ON transaction.recipient_id = profile.user_id WHERE sender_id=$1 ORDER BY time DESC LIMIT $2 OFFSET $3',
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
  db.query('SELECT count(*)::integer AS count FROM public.transaction WHERE sender_id=$1', [id], (err, res) => {
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

exports.transfer = (id, data, cb) => {
  val = []
  const filtered = {}
  const obj = {
    sender_id: id,
    recipient_id: data.recipient_id || id,
    notes: data.notes || 'Top Up',
    time: data.time || new Date(),
    type_id: data.type_id || 0,
    amount: parseInt(data.amount),
  }

  for (x in obj) {
    if (obj[x] !== null) {
      if (obj[x] !== undefined) {
        filtered[x] = obj[x]
        val.push(obj[x])
      }
    }
  }

  const key = Object.keys(filtered)
  const finalResult = key.map((val, index) => `$${index + 1}`)
  const query = `INSERT INTO transaction(${key}) VALUES(${finalResult}) RETURNING *`
  db.query(query, val, (err, res) => {
    // console.log(res);
    if (err) {
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
