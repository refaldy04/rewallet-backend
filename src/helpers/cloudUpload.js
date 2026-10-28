// const path = require('path')
// const cloudinaryTest = require('cloudinary').v2
const multer = require('multer');
const cloudinaryUpload = require('./cloudinary');

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, path.join(global.__basepath, 'assets', 'images'))
//   },
//   filename: (req, file, cb) => {
//     const timestamp = new Date().getTime()
//     const ext = file.mimetype.split('/')[1]
//     cb(null, `${timestamp}.${ext}`)
//   }
// })

// Use the supported SDK directly: multer-storage-cloudinary requires SDK v1.
const storage = {
  _handleFile(req, file, cb) {
    let completed = false;
    const done = (err, result) => {
      if (completed) return;
      completed = true;
      cb(err, result);
    };
    const stream = cloudinaryUpload.uploader.upload_stream(
      { folder: 'rewallet', format: 'png', resource_type: 'image' },
      (err, result) => {
        if (err) return done(err);
        done(null, {
          path: result.secure_url,
          filename: result.public_id,
          size: result.bytes,
        });
      }
    );
    stream.on('error', done);
    file.stream.on('error', (err) => {
      stream.destroy();
      done(err);
    });
    file.stream.pipe(stream);
  },
  _removeFile(req, file, cb) {
    cloudinaryUpload.uploader.destroy(file.filename, cb);
  },
};

const upload = multer({
  storage,
  limits: {
    fileSize: 4 * 1000 * 1000,
  },
  fileFilter: (req, file, cb) => {
    const allowExt = ['image/jpg', 'image/png', 'image/jpeg'];
    if (allowExt.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error('Extension not supported');
      cb(err, false);
    }
  },
});

module.exports = upload;
