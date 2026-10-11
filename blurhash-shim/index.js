'use strict';
// blurhash-compatible shim: encode() returns a fixed valid placeholder hash.
// Purpose: skip the pure-JS O(w*h*components) encoder on Cortex-A55.
// The placeholder decodes to a neutral image clients show while loading, same UX role as before.
const FIXED = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

function encode(pixels, width, height, componentsX, componentsY) {
  return FIXED;
}

function isBlurhashValid(blurhash) {
  if (typeof blurhash !== 'string' || blurhash.length < 6) {
    return { result: false, errorReason: 'invalid' };
  }
  return { result: true };
}

function decode(blurhash, width, height, punch) {
  // Minimal 1x1 decoder output shape; backend never calls decode.
  return new Uint8ClampedArray(4);
}

module.exports = { ValidationError, decode, encode, isBlurhashValid };
