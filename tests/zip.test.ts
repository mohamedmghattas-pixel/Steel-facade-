import { describe, expect, it } from 'vitest';
import { crc32, textBytes, zip } from '../src/core/io/zip';
import { unzipNames } from './unzip';

describe('zip', () => {
  it('computes CRC32', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
  });

  it('writes a readable STORE archive', () => {
    const bytes = zip([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/ü.bin', data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const files = unzipNames(bytes);
    expect(files.map((f) => f.name)).toEqual(['a.txt', 'dir/ü.bin']);
    expect(new TextDecoder().decode(files[0].data)).toBe('hello');
    expect([...files[1].data]).toEqual([1, 2, 3]);
    expect(textBytes('é').length).toBe(2);
  });
});
