import { describe, it, expect } from 'vitest';
import { CHANNEL_PREFIXES, getChannelFromJid } from '../src/channel-prefixes';

/** All IM channels that should be recognized as IM (non-web) channels. */
const ALL_IM_CHANNELS = [
  'feishu',
  'telegram',
  'qq',
  'wechat',
  'dingtalk',
] as const;

describe('channel prefix routing', () => {
  it('CHANNEL_PREFIXES contains all known IM channels', () => {
    for (const channel of ALL_IM_CHANNELS) {
      expect(CHANNEL_PREFIXES).toHaveProperty(channel);
    }
  });

  it('getChannelFromJid returns correct channel type for each prefix', () => {
    expect(getChannelFromJid('feishu:abc123')).toBe('feishu');
    expect(getChannelFromJid('telegram:abc123')).toBe('telegram');
    expect(getChannelFromJid('qq:abc123')).toBe('qq');
    expect(getChannelFromJid('wechat:abc123')).toBe('wechat');
    expect(getChannelFromJid('dingtalk:abc123')).toBe('dingtalk');
  });

  it('returns web for unrecognized prefix', () => {
    expect(getChannelFromJid('web:abc')).toBe('web');
    expect(getChannelFromJid('unknown:abc')).toBe('web');
  });
});
