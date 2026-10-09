// WHATWG euc-kr includes CP949, matching the server's Korean fallback.
const labels: Record<string, string> = { utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be', cp949: 'euc-kr' };
export default {
  decode(bytes: Uint8Array, encoding: string) { return new TextDecoder(labels[encoding] ?? encoding).decode(bytes); },
  encodingExists(encoding: string) { try { new TextDecoder(labels[encoding] ?? encoding); return true; } catch { return false; } },
};
