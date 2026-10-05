import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCrxSigner } from '../crx.js';

// Independent, bounded protobuf reader: this CRX subset only uses length-delimited fields.
function fields(bytes: Buffer): Map<number, Buffer> {
  let offset = 0;
  const result = new Map<number, Buffer>();
  function varint() {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      assert(offset < bytes.length, 'truncated varint');
      const byte = bytes[offset++]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('oversized varint');
  }
  while (offset < bytes.length) {
    const tag = varint(); assert.equal(tag & 7, 2);
    const size = varint(); assert(offset + size <= bytes.length);
    assert(!result.has(tag >>> 3));
    result.set(tag >>> 3, bytes.subarray(offset, offset + size)); offset += size;
  }
  return result;
}
function parse(crx: Buffer) {
  assert.equal(crx.toString('ascii', 0, 4), 'Cr24');
  assert.equal(crx.readUInt32LE(4), 3);
  const end = 12 + crx.readUInt32LE(8); assert(end < crx.length);
  const header = fields(crx.subarray(12, end));
  const proofType = header.has(3) ? 3 : 2;
  assert.deepEqual([...header.keys()].sort((a, b) => a - b), [proofType, 10000]);
  const proof = fields(header.get(proofType)!);
  const publicKey = proof.get(1)!, signature = proof.get(2)!;
  const signedHeader = header.get(10000)!;
  const id = fields(signedHeader).get(1)!;
  assert.equal(id.length, 16);
  assert.deepEqual(id, createHash('sha256').update(publicKey).digest().subarray(0, 16));
  const size = Buffer.alloc(4); size.writeUInt32LE(signedHeader.length);
  const zip = crx.subarray(end);
  const data = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'utf8'), size, signedHeader, zip]);
  const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  assert(verify('sha256', data, key, signature), 'valid CRX3 signature');
  return { proofType, publicKey, id, zip, key, signature, data };
}

// zipDirectory writes flat, uncompressed ZIP entries. Read the actual packaged manifest.
function zipManifest(zip: Buffer) {
  for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50;) {
    assert.equal(zip.readUInt16LE(offset + 8), 0);
    const size = zip.readUInt32LE(offset + 18), nameSize = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + nameSize + zip.readUInt16LE(offset + 28);
    if (zip.toString('utf8', offset + 30, offset + 30 + nameSize) === 'manifest.json') {
      return JSON.parse(zip.toString('utf8', start, start + size));
    }
    offset = start + size;
  }
  throw new Error('manifest.json missing from ZIP');
}

const syntheticZip = Buffer.from('PK\x05\x06' + '\0'.repeat(18)); // Empty ZIP; no external fixture data.

test('derived P-256 developer key has stable ID per secret and domain-separated seed', () => {
  const first = createCrxSigner({ APP_SECRET: 'synthetic-deployment-secret-a' });
  const again = createCrxSigner({ APP_SECRET: 'synthetic-deployment-secret-a' });
  const different = createCrxSigner({ APP_SECRET: 'synthetic-deployment-secret-b' });
  const a = parse(first.sign(syntheticZip)), b = parse(again.sign(syntheticZip)), c = parse(different.sign(syntheticZip));
  assert.equal(a.proofType, 3);
  assert.equal(a.key.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  assert.deepEqual(a.id, b.id); assert.notDeepEqual(a.id, c.id);
  assert.equal(first.manifestKey, again.manifestKey);
  assert.equal(first.manifestKey, a.publicKey.toString('base64'));
  assert.deepEqual(a.zip, syntheticZip);
  for (const offset of [0, 15, 16, 20, a.data.length - 1]) {
    const changed = Buffer.from(a.data); changed[offset] ^= 1;
    assert(!verify('sha256', changed, a.key, a.signature), 'context, length, ID and archive are authenticated');
  }
});

test('missing APP_SECRET uses a stable development key with an explicit warning', () => {
  const warnings: string[] = [];
  const first = createCrxSigner({}, message => warnings.push(message));
  const second = createCrxSigner({ APP_SECRET: '' }, message => warnings.push(message));
  assert.equal(first.manifestKey, second.manifestKey);
  assert.equal(warnings.length, 2);
  assert(warnings.every(message => message.includes('development only')));
});

for (const algorithm of ['ec', 'rsa'] as const) test(`optional PKCS#8 ${algorithm} key takes precedence over APP_SECRET`, () => {
  const { privateKey } = algorithm === 'ec'
    ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    : generateKeyPairSync('rsa', { modulusLength: 2048 });
  // Synthetic key stays in memory, including its PEM representation.
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const signer = createCrxSigner({ CONNECTOR_CRX_KEY: pem, APP_SECRET: 'synthetic-secret-a' });
  assert.equal(signer.manifestKey, createCrxSigner({ CONNECTOR_CRX_KEY: pem, APP_SECRET: 'synthetic-secret-b' }).manifestKey);
  assert.equal(signer.manifestKey, createCrxSigner({ CONNECTOR_CRX_KEY: pem }, () => assert.fail('unexpected dev warning')).manifestKey);
  const crx = parse(signer.sign(syntheticZip));
  assert.equal(crx.proofType, algorithm === 'rsa' ? 2 : 3);
  assert.equal(crx.publicKey.toString('base64'), signer.manifestKey);
});

test('invalid or unsupported explicit keys fail without falling back or exposing PEM', () => {
  assert.throws(() => createCrxSigner({ CONNECTOR_CRX_KEY: 'synthetic-invalid-key' }), { message: 'CONNECTOR_CRX_KEY must be an unencrypted PKCS#8 PEM private key' });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.throws(() => createCrxSigner({ CONNECTOR_CRX_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }), /must use P-256 or RSA/);
});

test('built CRX embeds the shipped Chromium ZIP and shares its unpacked manifest ID', async () => {
  // Run corepack pnpm build first (as in CI); do not silently skip missing artifacts.
  const install = new URL('../../web/public/install/', import.meta.url);
  const crx = parse(await readFile(new URL('moa-lite-connector-chromium.crx', install)));
  const zip = await readFile(new URL('moa-lite-connector-chromium.zip', install));
  assert.deepEqual(crx.zip, zip);
  const manifest = zipManifest(zip);
  assert.equal(manifest.key, crx.publicKey.toString('base64'));
  const unpacked = JSON.parse(await readFile(new URL('../../../.state/extension/chromium/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest, unpacked);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16), crx.id);
  assert(!('key' in zipManifest(await readFile(new URL('moa-lite-connector-firefox.zip', install)))));
});
