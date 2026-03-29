/**
 * Test helpers for Phase 0 constraint tests.
 *
 * These factories duplicate the private pure-function logic from IM channel files
 * (dingtalk.ts, qq.ts, wechat.ts) so we can test behavior without importing
 * the full modules (which have side-effects like SDK imports).
 *
 * When Phase 2 extracts these into src/im-utils.ts, the tests will import
 * from there instead — the assertions remain the same.
 */

// ─── markdownToPlainText (identical in dingtalk.ts, qq.ts, wechat.ts) ───

export function markdownToPlainText(md: string): string {
  let text = md;

  text = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  });

  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/~~(.+?)~~/g, '$1');
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  return text;
}

// ─── convertToDingTalkMarkdown (dingtalk.ts) ───

export function convertToDingTalkMarkdown(md: string): string {
  let text = md;
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/~~(.+?)~~/g, '$1');
  return text;
}

// ─── splitTextChunks (identical in dingtalk.ts, qq.ts, wechat.ts) ───

export function splitTextChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

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

// ─── parseQQChatId (qq.ts) ───

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
