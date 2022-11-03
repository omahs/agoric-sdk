/* global Buffer */
import { Transform } from 'stream';

// Transform objects which convert from hardened Arrays of JSON-serializable
// data into Buffers suitable for netstring conversion.

export function arrayEncoderStream() {
  function transform(object, encoding, callback) {
    if (!Array.isArray(object)) {
      throw Error('stream requires Arrays');
    }
    let err;
    try {
      this.push(Buffer.from(JSON.stringify(object)));
    } catch (e) {
      err = e;
    }
    callback(err);
  }
  // Array in, Buffer out, hence writableObjectMode
  return new Transform({ transform, writableObjectMode: true });
}

export function arrayDecoderStream() {
  function transform(buf, encoding, callback) {
    let err;
    try {
      if (!Buffer.isBuffer(buf)) {
        throw Error('stream expects Buffers');
      }
      // @ts-expect-error Buffer not assignable to string
      this.push(JSON.parse(buf));
    } catch (e) {
      err = e;
    }
    // this Transform is a one-to-one conversion of Buffer into Array, so we
    // always consume the input each time we're called
    callback(err);
  }

  // Buffer in, Array out, hence readableObjectMode
  return new Transform({ transform, readableObjectMode: true });
}
