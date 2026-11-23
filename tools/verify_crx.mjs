/*
 * Verify a CRX3 package: header structure, RSA proof and embedded zip.
 * Usage: node tools/verify_crx.mjs dist/page-radar-1.5.1.crx
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/verify_crx.mjs <file.crx>');
  process.exit(2);
}

const buf = fs.readFileSync(file);
if (buf.subarray(0, 4).toString() !== 'Cr24') throw new Error('not a CRX file (missing Cr24 magic)');
const version = buf.readUInt32LE(4);
const headerLen = buf.readUInt32LE(8);
const header = buf.subarray(12, 12 + headerLen);
const payload = buf.subarray(12 + headerLen);
if (version !== 3) throw new Error('unsupported CRX version ' + version);

function readVarint(b, i) {
  let out = 0;
  let shift = 0;
  for (;;) {
    const c = b[i++];
    out |= (c & 0x7f) << shift;
    if ((c & 0x80) === 0) return [out, i];
    shift += 7;
  }
}

function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let key;
    [key, i] = readVarint(b, i);
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 2) {
      let len;
      [len, i] = readVarint(b, i);
      out.push([field, b.subarray(i, i + len)]);
      i += len;
    } else if (wire === 0) {
      let v;
      [v, i] = readVarint(b, i);
      out.push([field, v]);
    } else {
      throw new Error('unexpected protobuf wire type ' + wire);
    }
  }
  return out;
}

const top = fields(header);
const proof = top.find(([f]) => f === 2 || f === 3);
const signedHeaderData = (top.find(([f]) => f === 10000) || [0, Buffer.alloc(0)])[1];
if (!proof) throw new Error('no asymmetric key proof in header');

const proofFields = fields(proof[1]);
const publicKey = proofFields.find(([f]) => f === 1)[1];
const signature = proofFields.find(([f]) => f === 2)[1];

const signed = Buffer.concat([
  Buffer.from('CRX3 SignedData\x00', 'binary'),
  Buffer.from([signedHeaderData.length & 0xff, (signedHeaderData.length >>> 8) & 0xff,
    (signedHeaderData.length >>> 16) & 0xff, (signedHeaderData.length >>> 24) & 0xff]),
  signedHeaderData,
  payload
]);

const key = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
const ok = crypto.verify('sha256', signed, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
if (!ok) throw new Error('signature does not verify');

const digest = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
const crxId = digest.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

// The payload is a plain zip; reuse the zip parser for a sanity check.
const zip = fs.readFileSync(file).subarray(12 + headerLen);
const endsig = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (endsig < 0) throw new Error('payload is not a zip archive');
const entries = zip.readUInt16LE(endsig + 10);
const manifestText = (() => {
  // Find the manifest.json entry through the central directory.
  let p = 0;
  const eocdOffset = endsig;
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);
  let i = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (i + 46 > zip.length) break;
    const nameLen = zip.readUInt16LE(i + 28);
    const extraLen = zip.readUInt16LE(i + 30);
    const commentLen = zip.readUInt16LE(i + 32);
    const name = zip.subarray(i + 46, i + 46 + nameLen).toString();
    if (name === 'manifest.json') {
      const local = zip.readUInt32LE(i + 42);
      const lNameLen = zip.readUInt16LE(local + 26);
      const lExtra = zip.readUInt16LE(local + 28);
      const compSize = zip.readUInt32LE(i + 20);
      const method = zip.readUInt16LE(i + 10);
      const dataStart = local + 30 + lNameLen + lExtra;
      const raw = zip.subarray(dataStart, dataStart + compSize);
      return method === 0 ? raw.toString() : zlib.inflateRawSync(raw).toString();
    }
    i += 46 + nameLen + extraLen + commentLen;
  }
  return null;
})();
const manifest = manifestText ? JSON.parse(manifestText) : {};

console.log(path.basename(file));
console.log('  crx version : ' + version);
console.log('  header bytes: ' + headerLen);
console.log('  payload     : ' + payload.length + ' bytes, ' + entries + ' zip entries');
console.log('  signature   : valid (RSA / SHA-256)');
console.log('  extension id: ' + crxId);
console.log('  name/version: ' + manifest.name + ' / ' + manifest.version);
