/**
 * Story D7 + A4: Markdown → Plain Text conversion
 *
 * Verifies that markdownToPlainText correctly strips formatting
 * for IM channels that only support plain text (DingTalk C2C, QQ, WeChat).
 */
import { describe, it, expect } from 'vitest';
import { markdownToPlainText } from '../helpers/im-utils';

describe('markdownToPlainText', () => {
  // ─── Code blocks ───

  it('strips fenced code block markers, keeps content', () => {
    const input = 'before\n```js\nconst x = 1;\n```\nafter';
    const result = markdownToPlainText(input);
    expect(result).toBe('before\nconst x = 1;\nafter');
  });

  it('strips fenced code block without language hint', () => {
    const input = '```\nhello\n```';
    const result = markdownToPlainText(input);
    expect(result).toBe('hello');
  });

  // ─── Inline code ───

  it('removes backticks from inline code', () => {
    expect(markdownToPlainText('use `npm install` to install')).toBe(
      'use npm install to install',
    );
  });

  // ─── Links ───

  it('converts [text](url) to "text (url)"', () => {
    expect(markdownToPlainText('[Google](https://google.com)')).toBe(
      'Google (https://google.com)',
    );
  });

  // ─── Bold ───

  it('strips **bold** markers', () => {
    expect(markdownToPlainText('this is **important**')).toBe(
      'this is important',
    );
  });

  it('strips __bold__ markers', () => {
    expect(markdownToPlainText('this is __important__')).toBe(
      'this is important',
    );
  });

  // ─── Strikethrough ───

  it('strips ~~strikethrough~~ markers', () => {
    expect(markdownToPlainText('~~deleted~~ text')).toBe('deleted text');
  });

  // ─── Italic ───

  it('strips *italic* markers', () => {
    expect(markdownToPlainText('this is *emphasized* text')).toBe(
      'this is emphasized text',
    );
  });

  // ─── Headings ───

  it('strips heading markers', () => {
    expect(markdownToPlainText('# Title')).toBe('Title');
    expect(markdownToPlainText('## Subtitle')).toBe('Subtitle');
    expect(markdownToPlainText('### H3')).toBe('H3');
    expect(markdownToPlainText('###### H6')).toBe('H6');
  });

  // ─── Combined ───

  it('handles mixed formatting', () => {
    const input = '# Hello\n\n**bold** and *italic* with `code`';
    const result = markdownToPlainText(input);
    expect(result).toBe('Hello\n\nbold and italic with code');
  });

  it('returns plain text unchanged', () => {
    const input = 'Hello, this is plain text.';
    expect(markdownToPlainText(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(markdownToPlainText('')).toBe('');
  });
});
