const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const cloudinary = require('../src/helpers/cloudinary');
const storage = require('../src/helpers/cloudUpload').storage;

test('Cloudinary storage preserves Multer metadata and removes uploads', async () => {
  const originalUpload = cloudinary.uploader.upload_stream;
  const originalDestroy = cloudinary.uploader.destroy;
  try {
    cloudinary.uploader.upload_stream = (options, callback) => {
      assert.equal(options.folder, 'rewallet');
      assert.equal(options.format, 'png');
      return new Writable({
        write(chunk, encoding, done) { done(); },
        final(done) {
          callback(null, { secure_url: 'https://example.com/image.png', public_id: 'rewallet/image', bytes: 3 });
          done();
        },
      });
    };
    const uploaded = await new Promise((resolve, reject) => {
      storage._handleFile({}, { stream: Readable.from(['abc']) }, (err, result) => err ? reject(err) : resolve(result));
    });
    assert.deepEqual(uploaded, { path: 'https://example.com/image.png', filename: 'rewallet/image', size: 3 });
    cloudinary.uploader.destroy = (id, callback) => {
      assert.equal(id, uploaded.filename);
      callback(null, { result: 'ok' });
    };
    await new Promise((resolve, reject) => storage._removeFile({}, uploaded, err => err ? reject(err) : resolve()));
    const failure = new Error('Upload failed');
    cloudinary.uploader.upload_stream = (options, callback) => new Writable({
      write(chunk, encoding, done) { callback(failure); done(); },
    });
    await assert.rejects(new Promise((resolve, reject) => {
      storage._handleFile({}, { stream: Readable.from(['abc']) }, (err, result) => err ? reject(err) : resolve(result));
    }), /Upload failed/);
  } finally {
    cloudinary.uploader.upload_stream = originalUpload;
    cloudinary.uploader.destroy = originalDestroy;
  }
});
