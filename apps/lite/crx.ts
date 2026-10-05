// SPDX-License-Identifier: GPL-3.0-or-later
import { constants, createECDH, createHash, createPrivateKey, createPublicKey, hkdfSync, sign, type KeyObject } from 'node:crypto';

const info = 'moa-lite connector crx v1';
const developmentSeed = 'moa-lite connector development only';
const p256Order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
type SigningEnvironment = { CONNECTOR_CRX_KEY?: string; APP_SECRET?: string };

function privateKey(env: SigningEnvironment): KeyObject {
  if (env.CONNECTOR_CRX_KEY) {
    // Reject unsupported/encrypted formats without including key material in errors.
    try {
      if (!env.CONNECTOR_CRX_KEY.trim().startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error();
      return createPrivateKey({ key: env.CONNECTOR_CRX_KEY, format: 'pem', type: 'pkcs8' });
    } catch { throw new Error('CONNECTOR_CRX_KEY must be an unencrypted PKCS#8 PEM private key'); }
  }
  // Empty HKDF salt is fixed; the versioned info separates this use from app auth.
  const bytes = Buffer.from(hkdfSync('sha256', env.APP_SECRET || developmentSeed, Buffer.alloc(0), info, 32));
  const scalar = BigInt('0x' + bytes.toString('hex')) % (p256Order - 1n) + 1n;
  const d = Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex');
  const ec = createECDH('prime256v1');
  ec.setPrivateKey(d);
  const point = ec.getPublicKey(undefined, 'uncompressed');
  return createPrivateKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', d: d.toString('base64url'),
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
  } });
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function field(number: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes;
}

/** Only public material and a signing closure escape; private keys are never persisted. */
export function createCrxSigner(env: SigningEnvironment, warn: (message: string) => void = console.warn) {
  const key = privateKey(env);
  const rsa = key.asymmetricKeyType === 'rsa';
  if (!(rsa && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) &&
      !(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1')) {
    throw new Error('CONNECTOR_CRX_KEY must use P-256 or RSA with at least 2048 bits');
  }
  if (!env.CONNECTOR_CRX_KEY && !env.APP_SECRET) warn('Connector CRX is for development only: APP_SECRET is absent; using a fixed public development seed.');
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const crxId = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return {
    manifestKey: publicKey.toString('base64'),
    sign(zip: Buffer): Buffer {
      // Chromium accepts either proof type as the developer key (not a store publisher proof):
      // https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/crx_verifier.cc
      // Field numbers and signed bytes: components/crx_file/crx3.proto in the same tree.
      const signedHeader = field(1, crxId);
      const data = Buffer.concat([Buffer.from('CRX3 SignedData\0'), uint32(signedHeader.length), signedHeader, zip]);
      // crx_verifier.cc uses RSA PKCS#1 v1.5 (despite the proto's old PSS comment), or DER ECDSA.
      const signature = sign('sha256', data, rsa ? { key, padding: constants.RSA_PKCS1_PADDING } : { key, dsaEncoding: 'der' });
      const proof = Buffer.concat([field(1, publicKey), field(2, signature)]);
      const header = Buffer.concat([field(rsa ? 2 : 3, proof), field(10000, signedHeader)]);
      // Chromium rejects ZIP end-record tokens anywhere in the protobuf header.
      if (['504b0506', '504b0607', '504b0606'].some(token => header.includes(Buffer.from(token, 'hex')))) {
        throw new Error('CRX header contains a reserved ZIP end-record token; rebuild or change the signing key');
      }
      return Buffer.concat([Buffer.from('Cr24'), uint32(3), uint32(header.length), header, zip]);
    },
  };
}
