import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { certificatePdf, qrSquares, type CertificateInput } from '@/lib/certificate';
import { sha256 } from '@/lib/commitments';

const INPUT: CertificateInput = {
  version: 1,
  docHash: `0x${'ab'.repeat(32)}`,
  recordId: `0x${'cd'.repeat(32)}`,
  familyId: `0x${'ef'.repeat(32)}`,
  chainId: 11155111,
  networkName: 'Ethereum Sepolia',
  contract: '0x87Ba96d1d48e280429A8ead1059334C34507c31F',
  txHash: `0x${'12'.repeat(32)}`,
  blockNumber: 9876543,
  verifyUrl: 'https://anchor.example/verify',
  explorerTxUrl: `https://sepolia.etherscan.io/tx/0x${'12'.repeat(32)}`,
};

/** Rasterises the squares exactly where the certificate draws them, flipping PDF y to image rows. */
function decodeSquares(text: string): string | null {
  const size = 240;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const square of qrSquares(text, 0, 0, size)) {
    // Edges, not sizes, so neighbouring squares meet without gaps.
    const [left, right] = [Math.floor(square.x), Math.floor(square.x + square.side)];
    const [top, bottom] = [Math.floor(size - square.y - square.side), Math.floor(size - square.y)];
    for (let row = top; row < bottom; row++) {
      for (let col = left; col < right; col++) pixels.fill(0, (row * size + col) * 4, (row * size + col) * 4 + 3);
    }
  }
  return jsQR(pixels, size, size)?.data ?? null;
}

describe('the verification certificate', () => {
  it('draws a QR code that decodes to the verify URL', () => {
    expect(decodeSquares(INPUT.verifyUrl)).toBe(INPUT.verifyUrl);
    expect(decodeSquares('https://anchor.example/verify?record=0x1234')).toBe('https://anchor.example/verify?record=0x1234');
  });

  it('is the same bytes for the same input, and different for another record', async () => {
    const [a, b, c] = await Promise.all([certificatePdf(INPUT), certificatePdf(INPUT), certificatePdf({ ...INPUT, recordId: `0x${'ce'.repeat(32)}` })]);
    expect(sha256(a)).toBe(sha256(b));
    expect(sha256(a)).not.toBe(sha256(c));
    expect(Buffer.from(a.subarray(0, 5)).toString()).toBe('%PDF-');
  });

  it('refuses input that is not a record', async () => {
    await expect(certificatePdf({ ...INPUT, recordId: '0x12' })).rejects.toThrow();
    await expect(certificatePdf({ ...INPUT, verifyUrl: 'not a url' })).rejects.toThrow();
  });
});
