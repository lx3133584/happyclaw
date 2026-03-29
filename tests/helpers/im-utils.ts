/**
 * Test helpers for Phase 0 constraint tests.
 *
 * Shared pure functions (markdownToPlainText, splitTextChunks) are re-exported
 * from src/im-utils.ts — the single source of truth.
 *
 * Functions below that are NOT in src/im-utils.ts duplicate private logic from
 * IM channel files (dingtalk.ts, qq.ts) for unit testing without importing
 * the full modules (which have side-effects like SDK imports).
 */

// ─── Re-exports from src/im-utils.ts (single source of truth) ───

export { markdownToPlainText, splitTextChunks } from '../../src/im-utils.js';

// ─── parseDingTalkChatId (dingtalk.ts) ───

export function parseDingTalkChatId(
  chatId: string,
): { type: 'c2c' | 'group'; conversationId: string } | null {
  if (chatId.startsWith('dingtalk:c2c:')) {
    return { type: 'c2c', conversationId: chatId.slice(13) };
  }
  if (chatId.startsWith('dingtalk:group:')) {
    return { type: 'group', conversationId: chatId.slice(15) };
  }
  if (chatId.startsWith('c2c:')) {
    return { type: 'c2c', conversationId: chatId.slice(4) };
  }
  if (chatId.startsWith('group:')) {
    return { type: 'group', conversationId: chatId.slice(6) };
  }
  if (chatId.startsWith('cid')) {
    return { type: 'group', conversationId: chatId };
  }
  return null;
}

// ─��─ parseQQChatId (qq.ts) ───

export function parseQQChatId(
  chatId: string,
): { type: 'c2c' | 'group'; openid: string } | null {
  if (chatId.startsWith('c2c:')) {
    return { type: 'c2c', openid: chatId.slice(4) };
  }
  if (chatId.startsWith('group:')) {
    return { type: 'group', openid: chatId.slice(6) };
  }
  return null;
}

// ─── MsgDedupCache (shared LRU/TTL pattern across 5 IM files) ───

export class MsgDedupCache {
  private cache = new Map<string, number>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(max = 1000, ttlMs = 30 * 60 * 1000) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  isDuplicate(msgId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of this.cache.entries()) {
      if (now - ts > this.ttlMs) {
        this.cache.delete(id);
      } else {
        break;
      }
    }
    if (this.cache.size >= this.max) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    return this.cache.has(msgId);
  }

  markSeen(msgId: string): void {
    this.cache.delete(msgId);
    this.cache.set(msgId, Date.now());
  }

  get size(): number {
    return this.cache.size;
  }
}
