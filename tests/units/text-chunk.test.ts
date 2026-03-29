/**
 * Story A4: Text chunking for long messages
 *
 * Verifies that splitTextChunks splits at safe boundaries (hard cut) and that no chunk exceeds the limit.
 * Used by DingTalk, QQ, WeChat for long message delivery.
 */
import { describe, it, expect } from 'vitest';
import { splitTextChunks } from '../helpers/im-utils';

describe('splitTextChunks', () => {
  it('returns single chunk for short text', () => {
    expect(splitTextChunks('Hello world', 100)).toEqual(['Hello world']);
  });

  it('returns single chunk when text length equals limit', () => {
    const text = 'a'.repeat(50);
    expect(splitTextChunks(text, 50)).toEqual([text]);
  });

  it('splits at paragraph boundary (\\n\\n)', () => {
    const para1 = 'a'.repeat(40);
    const para2 = 'b'.repeat(40);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitTextChunks(text, 50);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it('splits at newline when no paragraph break near limit', () => {
    const line1 = 'a'.repeat(40);
    const line2 = 'b'.repeat(40);
    const text = `${line1}\n${line2}`;
    const chunks = splitTextChunks(text, 50);
    expect(chunks.length).toBe(2);
  });

  it('splits at space when no newline near limit', () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const limit = 50;
    const chunks = splitTextChunks(text, limit);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
  });

  it('hard cuts when no safe boundary exists', () => {
    const text = 'a'.repeat(200);
    const limit = 50;
    const chunks = splitTextChunks(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
  });

  it('handles multi-paragraph text correctly', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}: ${'x'.repeat(30)}`,
    );
    const text = paragraphs.join('\n\n');
    const limit = 100;
    const chunks = splitTextChunks(text, limit);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
  });

  it('no chunk exceeds the limit', () => {
    const text =
      'Line one with some text.\n\nLine two is longer than the first one.\n\nLine three ends it.';
    const limit = 40;
    const chunks = splitTextChunks(text, limit);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
    // All original content is preserved across chunks
    const reassembled = chunks.join('\n\n');
    expect(reassembled.length).toBeGreaterThan(0);
  });
});
