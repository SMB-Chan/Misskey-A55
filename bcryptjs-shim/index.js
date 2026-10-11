'use strict';
// bcryptjs-compatible shim over native @node-rs/bcrypt.
// Purpose: replace pure-JS bcrypt (66ms/verify on Cortex-A55) with the native arm64 binary.
const bcrypt = require('@node-rs/bcrypt');

function roundsFrom(salt) {
  if (typeof salt === 'number' && isFinite(salt)) return salt;
  if (typeof salt === 'string' && salt.startsWith('$2')) {
    return parseInt(salt.split('$')[2], 10) || 10;
  }
  return 10;
}

function maybeCb(promise, cb) {
  if (typeof cb !== 'function') return promise;
  promise.then(function (r) { cb(null, r); }, function (e) { cb(e); });
  return undefined;
}

module.exports = {
  genSaltSync: function (rounds) {
    return bcrypt.genSaltSync(rounds == null ? { cost: 10 } : { cost: rounds });
  },
  genSalt: function (rounds, seedLength, cb) {
    if (typeof rounds === 'function') { cb = rounds; rounds = 10; }
    return maybeCb(Promise.resolve(this.genSaltSync(rounds)), cb);
  },
  hashSync: function (password, salt) {
    return bcrypt.hashSync(password, { cost: roundsFrom(salt) });
  },
  hash: function (password, salt, cb) {
    if (typeof salt === 'function') { cb = salt; salt = 10; }
    return maybeCb(Promise.resolve(this.hashSync(password, salt)), cb);
  },
  compareSync: function (password, hash) { return bcrypt.compareSync(password, hash); },
  compare: function (password, hash, cb) {
    return maybeCb(Promise.resolve(bcrypt.compareSync(password, hash)), cb);
  },
  getRounds: function (hash) { return parseInt(hash.split('$')[2], 10); },
  getSalt: function (hash) { return hash.slice(0, 29); },
  truncates: function (hash) { return hash.length === 59; },
  encodeBase64: function (b, len) { throw new Error('not supported by shim'); },
  decodeBase64: function (s, len) { throw new Error('not supported by shim'); },
  setRandomFallback: function (random) { /* no-op */ },
};
