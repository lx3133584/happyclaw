/**
 * Story D1: JID routing consistency
 *
 * Verifies that all channel prefix parsing is consistent
 * and that getChannelFromJid correctly identifies all IM channels.
 */
import { describe, it, expect } from 'vitest';
import {
  CHANNEL_PREFIXES,
  getChannelFromJid,
} from '../../src/channel-prefixes';
import { parseDingTalkChatId, parseQQChatId } from '../helpers/im-utils';

const ALL_IM_CHANNELS = [
  'feishu',
  'telegram',
  'qq',
  'wechat',
  'dingtalk',
] as const;

describe('D1: Channel prefix routing', () => {
  it('CHANNEL_PREFIXES contains all known IM channels', () => {
    for (const channel of ALL_IM_CHANNELS) {
      expect(CHANNEL_PREFIXES).toHaveProperty(channel);
    }
  });

  it('getChannelFromJid returns correct channel for each prefix', () => {
    expect(getChannelFromJid('feishu:oc_abc123')).toBe('feishu');
    expect(getChannelFromJid('telegram:123456')).toBe('telegram');
    expect(getChannelFromJid('qq:openid_xxx')).toBe('qq');
    expect(getChannelFromJid('wechat:wxid_xxx')).toBe('wechat');
    expect(getChannelFromJid('dingtalk:c2c:user123')).toBe('dingtalk');
    expect(getChannelFromJid('dingtalk:group:cid_xxx')).toBe('dingtalk');
  });

  it('returns "web" for unrecognized prefix', () => {
    expect(getChannelFromJid('web:main')).toBe('web');
    expect(getChannelFromJid('unknown:abc')).toBe('web');
    expect(getChannelFromJid('no-prefix')).toBe('web');
  });

  it('channel prefixes end with colon', () => {
    for (const [, prefix] of Object.entries(CHANNEL_PREFIXES)) {
      expect(prefix.endsWith(':')).toBe(true);
    }
  });
});

describe('DingTalk JID parsing', () => {
  // Fixed: dingtalk:c2c: is 13 chars; slice(13) correctly strips the prefix
  it('parses dingtalk:c2c:staffId', () => {
    const result = parseDingTalkChatId('dingtalk:c2c:staff123');
    expect(result).toEqual({ type: 'c2c', conversationId: 'staff123' });
  });

  // Fixed: dingtalk:group: is 15 chars; slice(15) correctly strips the prefix
  it('parses dingtalk:group:conversationId', () => {
    const result = parseDingTalkChatId('dingtalk:group:cidABC==');
    expect(result).toEqual({ type: 'group', conversationId: 'cidABC==' });
  });

  it('parses legacy c2c:staffId', () => {
    const result = parseDingTalkChatId('c2c:staff456');
    expect(result).toEqual({ type: 'c2c', conversationId: 'staff456' });
  });

  it('parses legacy group:conversationId', () => {
    const result = parseDingTalkChatId('group:cidXYZ');
    expect(result).toEqual({ type: 'group', conversationId: 'cidXYZ' });
  });

  it('parses legacy cid prefix as group', () => {
    const result = parseDingTalkChatId('cidLegacyFormat123');
    expect(result).toEqual({
      type: 'group',
      conversationId: 'cidLegacyFormat123',
    });
  });

  it('returns null for unrecognized format', () => {
    expect(parseDingTalkChatId('unknown:format')).toBeNull();
    expect(parseDingTalkChatId('')).toBeNull();
  });
});

describe('QQ JID parsing', () => {
  it('parses c2c:openid', () => {
    const result = parseQQChatId('c2c:USER_OPENID_123');
    expect(result).toEqual({ type: 'c2c', openid: 'USER_OPENID_123' });
  });

  it('parses group:openid', () => {
    const result = parseQQChatId('group:GROUP_OPENID_456');
    expect(result).toEqual({ type: 'group', openid: 'GROUP_OPENID_456' });
  });

  it('returns null for unrecognized format', () => {
    expect(parseQQChatId('feishu:oc_abc')).toBeNull();
    expect(parseQQChatId('')).toBeNull();
  });
});
