/**
 * Standard PDF decryption (Standard Security Handler, RC4 and AESV2/128-bit),
 * for files with an empty user password (the common "owner-password-only,
 * restricts printing/editing" case) but no password required to open.
 *
 * pdf-lib has no decryption support at all — `{ ignoreEncryption: true }`
 * only suppresses its "refuse to load" guard, it doesn't decrypt anything.
 * pdf.js does decrypt (hence previews work), but doesn't expose a public API
 * to get back decrypted raw bytes. So: detect encryption, derive the file
 * key per the PDF32000 spec (Algorithm 2), decrypt every stream (and best-
 * effort, every literal string) with the correct per-object key (Algorithm
 * 1), expand any object streams into standalone objects, and rebuild a
 * plain, unencrypted, classic-xref PDF that pdf-lib can load normally.
 *
 * Deliberately scoped: only the empty-user-password case (the overwhelming
 * majority of "protected" PDFs people actually encounter — a real password
 * prompt would need UI we don't have). AES-256 (R=5/6) isn't implemented —
 * `decryptPdf` throws a clear error for that case rather than corrupting
 * output silently.
 */

// ---------- MD5 (pure JS — needed for key derivation; Web Crypto has no MD5) ----------

function md5(bytes: Uint8Array): Uint8Array {
  function rotl(x: number, c: number) { return (x << c) | (x >>> (32 - c)); }
  const s = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  const msgLen = bytes.length;
  const withOne = msgLen + 1;
  const paddedLen = Math.ceil((withOne + 8) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[msgLen] = 0x80;
  const bitLen = BigInt(msgLen) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Number(bitLen & 0xffffffffn), true);
  view.setUint32(paddedLen - 4, Number((bitLen >> 32n) & 0xffffffffn), true);

  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;

  for (let chunkStart = 0; chunkStart < paddedLen; chunkStart += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getInt32(chunkStart + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, s[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, a0, true);
  outView.setInt32(4, b0, true);
  outView.setInt32(8, c0, true);
  outView.setInt32(12, d0, true);
  return out;
}

// ---------- RC4 (older, V1/V2 security handlers) ----------

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

async function aesCbcDecrypt(key: Uint8Array, ivAndCiphertext: Uint8Array): Promise<Uint8Array> {
  if (ivAndCiphertext.length < 16) return new Uint8Array(0);
  const iv = ivAndCiphertext.slice(0, 16);
  const ciphertext = ivAndCiphertext.slice(16);
  if (ciphertext.length === 0) return new Uint8Array(0);
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-CBC', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, cryptoKey, ciphertext as BufferSource);
  return new Uint8Array(plain);
}

/** Object streams are /FlateDecode-compressed on top of being encrypted —
 * decrypting only undoes the encryption layer, the result is still zlib
 * (RFC 1950) data that must be inflated before the contained objects are
 * readable. Uses the native DecompressionStream (Chromium/Electron/Node 18+)
 * rather than adding a zlib/pako dependency. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------- Standard security handler key derivation ----------

const PAD = new Uint8Array([
  0x28,0xbf,0x4e,0x5e,0x4e,0x75,0x8a,0x41,0x64,0x00,0x4e,0x56,0xff,0xfa,0x01,0x08,
  0x2e,0x2e,0x00,0xb6,0xd0,0x68,0x3e,0x80,0x2f,0x0c,0xa9,0xfe,0x64,0x53,0x69,0x7a,
]);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

interface EncryptInfo {
  v: number;
  r: number;
  oValue: Uint8Array;
  uValue: Uint8Array;
  p: number;
  keyLenBytes: number;
  id0: Uint8Array;
  encryptMetadata: boolean;
  isAes: boolean; // V4 CFM AESV2, or V5 (unsupported)
}

/** PDF32000 Algorithm 2 — empty user password only. */
function computeFileKey(info: EncryptInfo): Uint8Array {
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, info.p, true);
  const metaBytes = (!info.encryptMetadata && info.r >= 4) ? new Uint8Array([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0);
  let hash = md5(concatBytes(PAD, info.oValue, pBytes, info.id0, metaBytes));
  if (info.r >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash.slice(0, info.keyLenBytes));
  }
  return hash.slice(0, info.keyLenBytes);
}

/** PDF32000 Algorithm 1 (and 1.A note for AES) — per-object key. */
function computeObjectKey(fileKey: Uint8Array, objNum: number, gen: number, isAes: boolean): Uint8Array {
  const objBytes = new Uint8Array([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff]);
  const genBytes = new Uint8Array([gen & 0xff, (gen >> 8) & 0xff]);
  const salt = isAes ? new Uint8Array([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0); // "sAlT"
  const digest = md5(concatBytes(fileKey, objBytes, genBytes, salt));
  const n = Math.min(fileKey.length + 5, 16);
  return digest.slice(0, n);
}

// ---------- Minimal byte-level PDF scanning (no general parser needed) ----------

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function findAll(haystack: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(haystack))) out.push(m);
  return out;
}

/** Reads a bracket-balanced `<< ... >>` dict starting at `openAt` (index of first `<`). */
function readDict(text: string, openAt: number): { text: string; end: number } {
  let depth = 0;
  let i = openAt;
  while (i < text.length) {
    if (text.startsWith('<<', i)) { depth++; i += 2; continue; }
    if (text.startsWith('>>', i)) { depth--; i += 2; if (depth === 0) return { text: text.slice(openAt, i), end: i }; continue; }
    i++;
  }
  throw new Error('Unbalanced dictionary in PDF');
}

interface ParsedObject {
  num: number;
  gen: number;
  dictText: string; // includes surrounding << >>
  streamStart: number; // absolute byte offset of stream data start, -1 if no stream
  streamLength: number; // declared /Length, may be wrong for compressed edge cases but not for our path
  headerEnd: number; // absolute index right after "obj" keyword (where dict begins)
  objEnd: number; // absolute index right after this object (past endobj / endstream+endobj)
}

/** Sequentially scans the whole file for `N G obj ... endobj`, skipping over
 * declared stream byte ranges so binary stream content can never be
 * misread as a false object boundary. */
function scanObjects(text: string): ParsedObject[] {
  const objects: ParsedObject[] = [];
  const headerRe = /(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text))) {
    const num = parseInt(m[1], 10);
    const gen = parseInt(m[2], 10);
    const headerEnd = headerRe.lastIndex;
    let cursor = headerEnd;
    // Skip whitespace to find what follows: a dict, or a bare value (array,
    // ref, number, name, string, bool, null — all valid indirect-object
    // values per spec, e.g. "134 0 obj [434 0 R] endobj").
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    let dictText = '';
    let isDict = false;
    if (text.startsWith('<<', cursor)) {
      const { text: dText, end } = readDict(text, cursor);
      dictText = dText;
      cursor = end;
      isDict = true;
    }
    // Optional stream — only dict-valued objects can have one.
    let streamStart = -1;
    let streamLength = 0;
    if (isDict) {
      const streamMatch = /^[ \t\r\n]*stream\r?\n/.exec(text.slice(cursor, cursor + 32));
      if (streamMatch) {
        const lenMatch = /\/Length[ \t\r\n]+(\d+)/.exec(dictText);
        streamLength = lenMatch ? parseInt(lenMatch[1], 10) : 0;
        streamStart = cursor + streamMatch[0].length;
        cursor = streamStart + streamLength;
        // Skip to endstream (tolerates a stray byte or two before the keyword).
        const endstreamIdx = text.indexOf('endstream', cursor);
        if (endstreamIdx === -1) throw new Error(`Missing endstream for object ${num}`);
        cursor = endstreamIdx + 'endstream'.length;
      }
    }
    const endobjIdx = text.indexOf('endobj', cursor);
    if (!isDict) {
      dictText = text.slice(cursor, endobjIdx === -1 ? cursor : endobjIdx).trim();
    }
    const objEnd = endobjIdx === -1 ? cursor : endobjIdx + 'endobj'.length;
    objects.push({ num, gen, dictText, streamStart, streamLength, headerEnd, objEnd });
    headerRe.lastIndex = objEnd;
  }
  return objects;
}

/** Best-effort decrypt of literal `(...)` and hex `<...>` string values inside
 * a dict/array's text (not used for the dict structure itself — names,
 * numbers, and refs are never encrypted). Skips the case where a `<...>`
 * looks like it could be a nested dict opener (already excluded by caller
 * since dictText here has had its own `<<...>>` spans elided at the top
 * level — nested dicts are rare enough in the fields we care about that
 * this stays a best-effort pass, not required for page content fidelity). */
async function decryptStringsInPlace(
  dictText: string,
  objKey: Uint8Array,
  isAes: boolean,
): Promise<string> {
  // Literal strings (...) — handle nested parens/backslash escapes minimally.
  let out = '';
  let i = 0;
  while (i < dictText.length) {
    const ch = dictText[i];
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      const raw: number[] = [];
      while (j < dictText.length && depth > 0) {
        const c = dictText[j];
        if (c === '\\') { raw.push(dictText.charCodeAt(j)); if (j + 1 < dictText.length) raw.push(dictText.charCodeAt(j + 1)); j += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { j++; break; } }
        raw.push(dictText.charCodeAt(j));
        j++;
      }
      const bytes = new Uint8Array(raw);
      try {
        const dec = isAes ? await aesCbcDecrypt(objKey, bytes) : rc4(objKey, bytes);
        out += '(' + bytesToLatin1(dec).replace(/[\\()]/g, (c) => '\\' + c) + ')';
      } catch {
        out += dictText.slice(i, j); // leave as-is if it doesn't look like ciphertext we can handle
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------- Object stream expansion ----------

interface FlatObject {
  num: number;
  gen: number;
  body: string; // dict/value text, ready to place between "N 0 obj" and "endobj"
  streamBytes: Uint8Array | null;
}

async function expandObjectStream(
  dictText: string,
  decryptedStreamBytes: Uint8Array,
): Promise<FlatObject[]> {
  const nMatch = /\/N[ \t\r\n]+(\d+)/.exec(dictText);
  const firstMatch = /\/First[ \t\r\n]+(\d+)/.exec(dictText);
  if (!nMatch || !firstMatch) return [];
  const n = parseInt(nMatch[1], 10);
  const first = parseInt(firstMatch[1], 10);
  // Decrypting only undoes the encryption layer — ObjStm content is also
  // /FlateDecode-compressed, and must be inflated before it's readable.
  const isFlate = /\/Filter[ \t\r\n]*\/FlateDecode\b/.test(dictText);
  const streamBytes = isFlate ? await inflate(decryptedStreamBytes) : decryptedStreamBytes;
  const headerText = bytesToLatin1(streamBytes.slice(0, first));
  const nums = findAll(headerText, /(\d+)[ \t\r\n]+(\d+)/g).slice(0, n);
  const bodyText = bytesToLatin1(streamBytes.slice(first));
  const out: FlatObject[] = [];
  for (let k = 0; k < nums.length; k++) {
    const objNum = parseInt(nums[k][1], 10);
    const offset = parseInt(nums[k][2], 10);
    const nextOffset = k + 1 < nums.length ? parseInt(nums[k + 1][2], 10) : bodyText.length;
    const body = bodyText.slice(offset, nextOffset).trim();
    out.push({ num: objNum, gen: 0, body, streamBytes: null });
  }
  return out;
}

// ---------- Public API ----------

export function needsDecryption(bytes: ArrayBuffer): boolean {
  // Cheap check: only scan the trailer-ish tail plus a prefix, not the whole
  // (possibly multi-MB) buffer, since /Encrypt always sits in a small
  // dictionary near an xref/trailer, not buried in binary stream content.
  const bytesArr = new Uint8Array(bytes);
  const tailLen = Math.min(bytesArr.length, 8192);
  const tail = bytesToLatin1(bytesArr.slice(bytesArr.length - tailLen));
  return /\/Encrypt\b/.test(tail);
}

export async function decryptPdf(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const bytesArr = new Uint8Array(bytes);
  const text = bytesToLatin1(bytesArr);

  const tailLen = Math.min(text.length, 8192);
  const tail = text.slice(text.length - tailLen);
  const encRefMatch = /\/Encrypt[ \t\r\n]+(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+R/.exec(tail);
  if (!encRefMatch) return bytes; // no encryption after all

  const encObjNum = parseInt(encRefMatch[1], 10);
  const allObjects = scanObjects(text);
  const encObj = allObjects.find(o => o.num === encObjNum);
  if (!encObj) throw new Error('Could not locate the /Encrypt dictionary object.');

  const filterMatch = /\/Filter[ \t\r\n]*\/(\w+)/.exec(encObj.dictText);
  if (!filterMatch || filterMatch[1] !== 'Standard') {
    throw new Error('Unsupported encryption filter (only the Standard security handler is supported).');
  }
  const v = parseInt(/\/V[ \t\r\n]+(\d+)/.exec(encObj.dictText)?.[1] || '1', 10);
  const r = parseInt(/\/R[ \t\r\n]+(\d+)/.exec(encObj.dictText)?.[1] || '2', 10);
  if (r >= 5) {
    throw new Error('AES-256 (R5/R6) encrypted PDFs are not supported yet — only 40/128-bit RC4 and AES-128.');
  }
  const oHex = /\/O[ \t\r\n]*<([0-9A-Fa-f \t\r\n]+)>/.exec(encObj.dictText);
  const oLit = /\/O\(/.exec(encObj.dictText);
  const uHex = /\/U[ \t\r\n]*<([0-9A-Fa-f \t\r\n]+)>/.exec(encObj.dictText);
  const oValue = oHex ? hexToBytes(oHex[1]) : readLiteralStringBytes(encObj.dictText, encObj.dictText.indexOf('/O(') + 2);
  const uValue = uHex ? hexToBytes(uHex[1]) : readLiteralStringBytes(encObj.dictText, encObj.dictText.indexOf('/U(') + 2);
  const pMatch = /\/P[ \t\r\n]+(-?\d+)/.exec(encObj.dictText);
  const p = pMatch ? parseInt(pMatch[1], 10) : 0;
  const lengthBitsMatch = /\/Length[ \t\r\n]+(\d+)/.exec(encObj.dictText.replace(/\/CF[\s\S]*?>>>>/, ''));
  const keyLenBytes = v >= 4 ? 16 : Math.max(5, Math.floor((lengthBitsMatch ? parseInt(lengthBitsMatch[1], 10) : 40) / 8));
  const encryptMetadataMatch = /\/EncryptMetadata[ \t\r\n]+(true|false)/.exec(encObj.dictText);
  const encryptMetadata = encryptMetadataMatch ? encryptMetadataMatch[1] === 'true' : true;
  const isAes = v >= 4 && /\/CFM[ \t\r\n]*\/AESV2/.test(encObj.dictText);
  void oLit;

  const idMatch = /\/ID[ \t\r\n]*\[[ \t\r\n]*<([0-9A-Fa-f]+)>/.exec(tail) || /\/ID[ \t\r\n]*\[[ \t\r\n]*<([0-9A-Fa-f]+)>/.exec(text);
  if (!idMatch) throw new Error('Could not find the file /ID needed to derive the decryption key.');
  const id0 = hexToBytes(idMatch[1]);

  const info: EncryptInfo = { v, r, oValue, uValue, p, keyLenBytes, id0, encryptMetadata, isAes };
  const fileKey = computeFileKey(info);

  // Root, for the rebuilt trailer — comes from the same dict as /Encrypt in
  // an xref-stream file (that dict doubles as the trailer), or from a
  // classic `trailer<<...>>` section if present.
  const trailerDictMatch = /trailer[ \t\r\n]*(<<[\s\S]*?>>)/.exec(text);
  const rootSource = trailerDictMatch ? trailerDictMatch[1] : tail;
  const rootMatch = /\/Root[ \t\r\n]+(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+R/.exec(rootSource) || /\/Root[ \t\r\n]+(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+R/.exec(text);
  if (!rootMatch) throw new Error('Could not find /Root (the document catalog) to rebuild the file.');
  const rootNum = parseInt(rootMatch[1], 10);

  // Decrypt every object; expand object streams into their contained objects.
  const flat: FlatObject[] = [];
  for (const obj of allObjects) {
    if (obj.num === encObjNum) continue; // the encryption dict itself is dropped from the output
    const isObjStm = /\/Type[ \t\r\n]*\/ObjStm\b/.test(obj.dictText);
    const isXRefStream = /\/Type[ \t\r\n]*\/XRef\b/.test(obj.dictText);
    if (isXRefStream) continue; // we rebuild a fresh classic xref; drop the old one

    let streamBytes: Uint8Array | null = null;
    if (obj.streamStart >= 0) {
      const ciphertext = bytesArr.slice(obj.streamStart, obj.streamStart + obj.streamLength);
      const objKey = computeObjectKey(fileKey, obj.num, obj.gen, isAes);
      streamBytes = isAes ? await aesCbcDecrypt(objKey, ciphertext) : rc4(objKey, ciphertext);
    }

    if (isObjStm && streamBytes) {
      const expanded = await expandObjectStream(obj.dictText, streamBytes);
      flat.push(...expanded);
      continue;
    }

    let bodyText: string;
    if (streamBytes) {
      const lengthReplaced = obj.dictText.replace(/\/Length[ \t\r\n]+\d+/, `/Length ${streamBytes.length}`);
      bodyText = lengthReplaced;
    } else {
      const objKey = computeObjectKey(fileKey, obj.num, obj.gen, isAes);
      bodyText = await decryptStringsInPlace(obj.dictText, objKey, isAes);
    }
    flat.push({ num: obj.num, gen: obj.gen, body: bodyText, streamBytes });
  }

  return serializePdf(flat, rootNum);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[ \t\r\n]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function readLiteralStringBytes(dictText: string, openParenIdx: number): Uint8Array {
  if (openParenIdx < 1) return new Uint8Array(0);
  let depth = 1;
  let j = openParenIdx + 1;
  const raw: number[] = [];
  while (j < dictText.length && depth > 0) {
    const c = dictText[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
    raw.push(dictText.charCodeAt(j));
    j++;
  }
  return new Uint8Array(raw);
}

function serializePdf(objects: FlatObject[], rootNum: number): ArrayBuffer {
  objects.sort((a, b) => a.num - b.num);
  const chunks: Uint8Array[] = [];
  const offsets = new Map<number, number>();
  let pos = 0;

  const header = new TextEncoder().encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  chunks.push(header);
  pos += header.length;

  for (const obj of objects) {
    offsets.set(obj.num, pos);
    const headerBytes = new TextEncoder().encode(`${obj.num} ${obj.gen} obj\n`);
    chunks.push(headerBytes); pos += headerBytes.length;
    const bodyBytes = latin1ToBytes(obj.body);
    chunks.push(bodyBytes); pos += bodyBytes.length;
    if (obj.streamBytes) {
      const streamHeader = new TextEncoder().encode('\nstream\n');
      chunks.push(streamHeader); pos += streamHeader.length;
      chunks.push(obj.streamBytes); pos += obj.streamBytes.length;
      const streamFooter = new TextEncoder().encode('\nendstream');
      chunks.push(streamFooter); pos += streamFooter.length;
    }
    const footer = new TextEncoder().encode('\nendobj\n');
    chunks.push(footer); pos += footer.length;
  }

  const maxNum = objects.length ? Math.max(...objects.map(o => o.num)) : 0;
  const xrefStart = pos;
  let xrefText = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets.get(n);
    xrefText += off !== undefined ? `${String(off).padStart(10, '0')} 00000 n \n` : `0000000000 00000 f \n`;
  }
  const xrefBytes = new TextEncoder().encode(xrefText);
  chunks.push(xrefBytes); pos += xrefBytes.length;

  const trailerText = `trailer\n<< /Size ${maxNum + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  const trailerBytes = new TextEncoder().encode(trailerText);
  chunks.push(trailerBytes); pos += trailerBytes.length;

  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
