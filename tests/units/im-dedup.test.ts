/**
 * Story A10: Message deduplication
 *
 * Verifies the LRU + TTL dedup cache behavior shared across
 * all 5 IM channels (feishu, telegram, qq, dingtalk, wechat).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MsgDedupCache } from '../helpers/im-utils';

describe('MsgDedupCache', () => {
  it('new message is not duplicate', () => {
    const cache = new MsgDedupCache();
    expect(cache.isDuplicate('msg-1')).toBe(false);
  });

  it('same message seen twice is duplicate', () => {
    const cache = new MsgDedupCache();
    cache.markSeen('msg-1');
    expect(cache.isDuplicate('msg-1')).toBe(true);
  });

  it('different messages are not duplicates', () => {
    const cache = new MsgDedupCache();
    cache.markSeen('msg-1');
    expect(cache.isDuplicate('msg-2')).toBe(false);
  });

  it('evicts oldest when max capacity reached', () => {
    const cache = new MsgDedupCache(3);
    cache.markSeen('msg-1');
    cache.markSeen('msg-2');
    cache.markSeen('msg-3');
    // Cache is full (3). Adding a 4th should evict msg-1
    cache.markSeen('msg-4');
    expect(cache.isDuplicate('msg-1')).toBe(false); // evicted
    expect(cache.isDuplicate('msg-4')).toBe(true); // just added
  });

  it('markSeen refreshes insertion order (LRU)', () => {
    const cache = new MsgDedupCache(3);
    cache.markSeen('msg-1');
    cache.markSeen('msg-2');
    cache.markSeen('msg-3');
    // Re-touch msg-1 — it moves to end, so msg-2 becomes oldest
    cache.markSeen('msg-1');
    cache.markSeen('msg-4'); // should evict msg-2 (oldest)
    expect(cache.isDuplicate('msg-2')).toBe(false); // evicted
    expect(cache.isDuplicate('msg-1')).toBe(true); // refreshed
  });

  it('expired entries are pruned on isDuplicate check', () => {
    const cache = new MsgDedupCache(100, 100); // 100ms TTL for fast test
    cache.markSeen('old-msg');

    // Advance time past TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);

    expect(cache.isDuplicate('old-msg')).toBe(false); // expired
    vi.useRealTimers();
  });

  it('non-expired entries remain valid', () => {
    const cache = new MsgDedupCache(100, 5000);
    cache.markSeen('recent-msg');
    expect(cache.isDuplicate('recent-msg')).toBe(true);
  });

  it('default max is 1000 and evicts at capacity', () => {
    const cache = new MsgDedupCache();
    // Fill to capacity
    for (let i = 0; i < 1000; i++) {
      cache.markSeen(`msg-${i}`);
    }
    expect(cache.size).toBe(1000);
    // One more should trigger eviction (checked on next isDuplicate call)
    cache.markSeen('msg-1000');
    // isDuplicate triggers cleanup which evicts oldest
    expect(cache.isDuplicate('msg-0')).toBe(false); // evicted
    expect(cache.isDuplicate('msg-1000')).toBe(true); // still present
  });
});
