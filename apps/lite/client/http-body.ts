// SPDX-License-Identifier: GPL-3.0-or-later
/** Mangayomi binary responses are byte strings, not lossy UTF-8 text. */
export function decodeHttpBody(bytes: Uint8Array, contentType = ''): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const text = !mime || mime.startsWith('text/') || /(?:json|xml|javascript|ecmascript|x-www-form-urlencoded)$/.test(mime);
  if (!charset && !text) {
    let body = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
      body += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return body;
  }
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
  catch { throw new Error('source_encoding_unsupported'); }
}
