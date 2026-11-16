/**
 * Source files in the encoding they already have. Most are UTF-8, but legacy Windows code is often
 * Windows-1252. Read as UTF-8, each accented letter of such a file becomes U+FFFD, and writing that
 * back destroys them for good, in lines the edit never touched. So a file that is not valid UTF-8 is
 * read as Windows-1252 and written back in it. That mapping covers all 256 byte values one to one,
 * so every byte an edit did not change comes back exactly as it was, whatever the real code page.
 */
import { readFile } from 'node:fs/promises';

export type SourceEncoding = 'utf8' | 'windows-1252';

export interface SourceText {
  text: string;
  encoding: SourceEncoding;
}

/** What bytes 0x80-0x9F mean in Windows-1252. The five it leaves undefined stand for themselves. */
const HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178
];
let byteOfHigh: Map<number, number> | undefined;

// fatal: a byte that is not UTF-8 means another encoding, not a character to replace.
// ignoreBOM: keep a BOM in the text, so the write puts it back.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeSource(bytes: Uint8Array): SourceText {
  try {
    return { text: utf8.decode(bytes), encoding: 'utf8' };
  } catch {
    const latin1 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    return { text: latin1.replace(/[\x80-\x9f]/g, c => String.fromCharCode(HIGH[c.charCodeAt(0) - 0x80])), encoding: 'windows-1252' };
  }
}

export async function readSource(file: string): Promise<SourceText> {
  return decodeSource(await readFile(file));
}

/** `text` as bytes in `encoding`. Throws, naming the character and its line, when the encoding has no byte for it. */
export function encodeSource(text: string, encoding: SourceEncoding): Buffer {
  if (encoding === 'utf8') return Buffer.from(text, 'utf8');
  byteOfHigh ??= new Map(HIGH.map((code, i) => [code, 0x80 + i]));
  const out = Buffer.allocUnsafe(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const byte = code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : byteOfHigh.get(code);
    if (byte === undefined) {
      const point = text.codePointAt(i)!;
      const line = text.slice(0, i).split('\n').length;
      throw new Error(
        `"${String.fromCodePoint(point)}" (U+${point.toString(16).toUpperCase().padStart(4, '0')}) on line ${line} of the new text ` +
          'has no byte in Windows-1252, the encoding of this file. Write it another way, e.g. as an escape.'
      );
    }
    out[i] = byte;
  }
  return out;
}
