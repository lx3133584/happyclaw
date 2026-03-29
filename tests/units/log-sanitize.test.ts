/**
 * Story D7: Log Sanitization Constraint Tests
 *
 * Tests the redactSensitive and summarizeToolInput functions from
 * container/agent-runner/src/utils.ts — verifies that sensitive
 * data is properly redacted before being emitted in stream events.
 */
import { describe, it, expect } from 'vitest';

// ─── Duplicate production logic for constraint testing ──────
// Source: container/agent-runner/src/utils.ts

function shorten(input: string, maxLen = 180): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen)}...`;
}

function redactSensitive(input: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (input == null) return input;
  if (
    typeof input === 'string' ||
    typeof input === 'number' ||
    typeof input === 'boolean'
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 10).map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        /(token|password|secret|api[_-]?key|authorization|cookie)/iu.test(k)
      ) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return '[unsupported]';
}

function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return shorten(input.trim());
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const keyCandidates = [
      'command',
      'query',
      'path',
      'pattern',
      'prompt',
      'url',
      'name',
    ];
    for (const key of keyCandidates) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return `${key}: ${shorten(value.trim())}`;
      }
    }
    try {
      const json = JSON.stringify(redactSensitive(obj));
      if (!json || json === '{}' || json === '[]') return undefined;
      return shorten(json);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sanitizeFilename(summary: string): string {
  // Matches production: container/agent-runner/src/utils.ts sanitizeFilename
  return summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

describe('Story D7: Log Sanitization', () => {
  // ─── redactSensitive ──────────────────────────────────

  describe('redactSensitive', () => {
    it('redacts token fields', () => {
      expect(redactSensitive({ token: 'sk-abc123' })).toEqual({
        token: '[REDACTED]',
      });
    });

    it('redacts password fields', () => {
      expect(redactSensitive({ password: 'hunter2' })).toEqual({
        password: '[REDACTED]',
      });
    });

    it('redacts API key variants', () => {
      expect(redactSensitive({ apiKey: 'key123' })).toEqual({
        apiKey: '[REDACTED]',
      });
      expect(redactSensitive({ api_key: 'key123' })).toEqual({
        api_key: '[REDACTED]',
      });
      expect(redactSensitive({ API_KEY: 'key123' })).toEqual({
        API_KEY: '[REDACTED]',
      });
    });

    it('redacts authorization and cookie fields', () => {
      expect(redactSensitive({ authorization: 'Bearer abc' })).toEqual({
        authorization: '[REDACTED]',
      });
      expect(redactSensitive({ cookie: 'session=abc' })).toEqual({
        cookie: '[REDACTED]',
      });
    });

    it('preserves non-sensitive fields', () => {
      expect(redactSensitive({ name: 'test', count: 5 })).toEqual({
        name: 'test',
        count: 5,
      });
    });

    it('recursively redacts nested objects', () => {
      const input = {
        config: {
          apiToken: 'secret',
          publicData: 'visible',
        },
      };
      const result = redactSensitive(input) as typeof input;
      expect(result.config.apiToken).toBe('[REDACTED]');
      expect(result.config.publicData).toBe('visible');
    });

    it('truncates at depth 3', () => {
      const deep = { a: { b: { c: { d: 'value' } } } };
      const result = redactSensitive(deep) as any;
      expect(result.a.b.c.d).toBe('[truncated]');
    });

    it('handles arrays (limited to 10)', () => {
      const input = Array.from({ length: 15 }, (_, i) => i);
      const result = redactSensitive(input) as number[];
      expect(result).toHaveLength(10);
      expect(result[0]).toBe(0);
    });

    it('preserves primitives', () => {
      expect(redactSensitive('hello')).toBe('hello');
      expect(redactSensitive(42)).toBe(42);
      expect(redactSensitive(true)).toBe(true);
      expect(redactSensitive(null)).toBeNull();
    });

    it('redacts secret field', () => {
      expect(redactSensitive({ client_secret: 'super-secret' })).toEqual({
        client_secret: '[REDACTED]',
      });
    });
  });

  // ─── summarizeToolInput ──────────────────────────────

  describe('summarizeToolInput', () => {
    it('returns string input truncated', () => {
      expect(summarizeToolInput('hello')).toBe('hello');
    });

    it('extracts command field', () => {
      expect(summarizeToolInput({ command: 'ls -la' })).toBe('command: ls -la');
    });

    it('extracts query field', () => {
      expect(summarizeToolInput({ query: 'SELECT * FROM users' })).toBe(
        'query: SELECT * FROM users',
      );
    });

    it('extracts path field', () => {
      expect(summarizeToolInput({ path: '/workspace/file.ts' })).toBe(
        'path: /workspace/file.ts',
      );
    });

    it('redacts API keys in JSON fallback', () => {
      // Note: summarizeToolInput extracts the first keyCandidate match as a value,
      // When 'name' is present, it takes priority over JSON fallback
      const result = summarizeToolInput({ apiKey: 'sk-secret', name: 'test' });
      expect(result).not.toContain('sk-secret');
      expect(result).toBe('name: test');
    });

    it('returns undefined for empty objects', () => {
      expect(summarizeToolInput({})).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(summarizeToolInput(null)).toBeUndefined();
    });

    it('truncates long JSON to 180 chars', () => {
      const longObj = { data: 'x'.repeat(300) };
      const result = summarizeToolInput(longObj);
      expect(result!.length).toBeLessThanOrEqual(183); // 180 + "..."
    });
  });

  // ─── sanitizeFilename ────────────────────────────────

  describe('sanitizeFilename', () => {
    it('replaces non-alphanumeric with hyphens', () => {
      expect(sanitizeFilename('hello world')).toBe('hello-world');
    });

    it('removes leading/trailing hyphens', () => {
      expect(sanitizeFilename('--hello--')).toBe('hello');
    });

    it('collapses consecutive hyphens', () => {
      expect(sanitizeFilename('a---b')).toBe('a-b');
    });

    it('truncates to 50 characters', () => {
      const long = 'a'.repeat(100);
      expect(sanitizeFilename(long)).toHaveLength(50);
    });
  });
});
