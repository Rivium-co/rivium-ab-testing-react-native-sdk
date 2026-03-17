/**
 * Simple MD5 hash for deterministic bucketing.
 * Pure JS implementation — no native dependencies.
 */
export function createHash(input: string): string {
  const bytes = stringToBytes(input);
  const hash = md5(bytes);
  return bytesToHex(hash);
}

function stringToBytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(
        0xe0 | (c >> 12),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      );
    } else {
      i++;
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      );
    }
  }
  return bytes;
}

function bytesToHex(bytes: number[]): string {
  const hex: string[] = [];
  for (const b of bytes) {
    hex.push((b >>> 4).toString(16));
    hex.push((b & 0x0f).toString(16));
  }
  return hex.join('');
}

function md5(bytes: number[]): number[] {
  const m = bytesToWords(bytes);
  const l = bytes.length * 8;

  m[l >>> 5] |= 0x80 << l % 32;
  m[(((l + 64) >>> 9) << 4) + 14] = l;

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let i = 0; i < m.length; i += 16) {
    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    a = ff(a, b, c, d, m[i + 0] || 0, 7, 0xd76aa478);
    d = ff(d, a, b, c, m[i + 1] || 0, 12, 0xe8c7b756);
    c = ff(c, d, a, b, m[i + 2] || 0, 17, 0x242070db);
    b = ff(b, c, d, a, m[i + 3] || 0, 22, 0xc1bdceee);
    a = ff(a, b, c, d, m[i + 4] || 0, 7, 0xf57c0faf);
    d = ff(d, a, b, c, m[i + 5] || 0, 12, 0x4787c62a);
    c = ff(c, d, a, b, m[i + 6] || 0, 17, 0xa8304613);
    b = ff(b, c, d, a, m[i + 7] || 0, 22, 0xfd469501);
    a = ff(a, b, c, d, m[i + 8] || 0, 7, 0x698098d8);
    d = ff(d, a, b, c, m[i + 9] || 0, 12, 0x8b44f7af);
    c = ff(c, d, a, b, m[i + 10] || 0, 17, 0xffff5bb1);
    b = ff(b, c, d, a, m[i + 11] || 0, 22, 0x895cd7be);
    a = ff(a, b, c, d, m[i + 12] || 0, 7, 0x6b901122);
    d = ff(d, a, b, c, m[i + 13] || 0, 12, 0xfd987193);
    c = ff(c, d, a, b, m[i + 14] || 0, 17, 0xa679438e);
    b = ff(b, c, d, a, m[i + 15] || 0, 22, 0x49b40821);

    a = gg(a, b, c, d, m[i + 1] || 0, 5, 0xf61e2562);
    d = gg(d, a, b, c, m[i + 6] || 0, 9, 0xc040b340);
    c = gg(c, d, a, b, m[i + 11] || 0, 14, 0x265e5a51);
    b = gg(b, c, d, a, m[i + 0] || 0, 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, m[i + 5] || 0, 5, 0xd62f105d);
    d = gg(d, a, b, c, m[i + 10] || 0, 9, 0x02441453);
    c = gg(c, d, a, b, m[i + 15] || 0, 14, 0xd8a1e681);
    b = gg(b, c, d, a, m[i + 4] || 0, 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, m[i + 9] || 0, 5, 0x21e1cde6);
    d = gg(d, a, b, c, m[i + 14] || 0, 9, 0xc33707d6);
    c = gg(c, d, a, b, m[i + 3] || 0, 14, 0xf4d50d87);
    b = gg(b, c, d, a, m[i + 8] || 0, 20, 0x455a14ed);
    a = gg(a, b, c, d, m[i + 13] || 0, 5, 0xa9e3e905);
    d = gg(d, a, b, c, m[i + 2] || 0, 9, 0xfcefa3f8);
    c = gg(c, d, a, b, m[i + 7] || 0, 14, 0x676f02d9);
    b = gg(b, c, d, a, m[i + 12] || 0, 20, 0x8d2a4c8a);

    a = hh(a, b, c, d, m[i + 5] || 0, 4, 0xfffa3942);
    d = hh(d, a, b, c, m[i + 8] || 0, 11, 0x8771f681);
    c = hh(c, d, a, b, m[i + 11] || 0, 16, 0x6d9d6122);
    b = hh(b, c, d, a, m[i + 14] || 0, 23, 0xfde5380c);
    a = hh(a, b, c, d, m[i + 1] || 0, 4, 0xa4beea44);
    d = hh(d, a, b, c, m[i + 4] || 0, 11, 0x4bdecfa9);
    c = hh(c, d, a, b, m[i + 7] || 0, 16, 0xf6bb4b60);
    b = hh(b, c, d, a, m[i + 10] || 0, 23, 0xbebfbc70);
    a = hh(a, b, c, d, m[i + 13] || 0, 4, 0x289b7ec6);
    d = hh(d, a, b, c, m[i + 0] || 0, 11, 0xeaa127fa);
    c = hh(c, d, a, b, m[i + 3] || 0, 16, 0xd4ef3085);
    b = hh(b, c, d, a, m[i + 6] || 0, 23, 0x04881d05);
    a = hh(a, b, c, d, m[i + 9] || 0, 4, 0xd9d4d039);
    d = hh(d, a, b, c, m[i + 12] || 0, 11, 0xe6db99e5);
    c = hh(c, d, a, b, m[i + 15] || 0, 16, 0x1fa27cf8);
    b = hh(b, c, d, a, m[i + 2] || 0, 23, 0xc4ac5665);

    a = ii(a, b, c, d, m[i + 0] || 0, 6, 0xf4292244);
    d = ii(d, a, b, c, m[i + 7] || 0, 10, 0x432aff97);
    c = ii(c, d, a, b, m[i + 14] || 0, 15, 0xab9423a7);
    b = ii(b, c, d, a, m[i + 5] || 0, 21, 0xfc93a039);
    a = ii(a, b, c, d, m[i + 12] || 0, 6, 0x655b59c3);
    d = ii(d, a, b, c, m[i + 3] || 0, 10, 0x8f0ccc92);
    c = ii(c, d, a, b, m[i + 10] || 0, 15, 0xffeff47d);
    b = ii(b, c, d, a, m[i + 1] || 0, 21, 0x85845dd1);
    a = ii(a, b, c, d, m[i + 8] || 0, 6, 0x6fa87e4f);
    d = ii(d, a, b, c, m[i + 15] || 0, 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, m[i + 6] || 0, 15, 0xa3014314);
    b = ii(b, c, d, a, m[i + 13] || 0, 21, 0x4e0811a1);
    a = ii(a, b, c, d, m[i + 4] || 0, 6, 0xf7537e82);
    d = ii(d, a, b, c, m[i + 11] || 0, 10, 0xbd3af235);
    c = ii(c, d, a, b, m[i + 2] || 0, 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, m[i + 9] || 0, 21, 0xeb86d391);

    a = add(a, aa);
    b = add(b, bb);
    c = add(c, cc);
    d = add(d, dd);
  }

  return wordsToBytes([a, b, c, d]);
}

function bytesToWords(bytes: number[]): number[] {
  const words: number[] = [];
  for (let i = 0, j = 0; i < bytes.length; i++, j += 8) {
    words[j >>> 5] |= bytes[i] << j % 32;
  }
  return words;
}

function wordsToBytes(words: number[]): number[] {
  const bytes: number[] = [];
  for (let b = 0; b < words.length * 32; b += 8) {
    bytes.push((words[b >>> 5] >>> b % 32) & 0xff);
  }
  return bytes;
}

function add(x: number, y: number): number {
  const lsw = (x & 0xffff) + (y & 0xffff);
  const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
  return (msw << 16) | (lsw & 0xffff);
}

function cmn(
  q: number,
  a: number,
  b: number,
  x: number,
  s: number,
  t: number
): number {
  a = add(add(a, q), add(x, t));
  return add((a << s) | (a >>> (32 - s)), b);
}

function ff(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number
): number {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number
): number {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number
): number {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number
): number {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
