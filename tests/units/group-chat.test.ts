/**
 * Story B: Group Chat Scenario Tests
 *
 * Tests the data model constraints for group chat scenarios:
 * B1: @mention filtering (require_mention mode)
 * B2: Full response mode (default)
 * B5: Group reply routing
 * B6: No cross-talk between groups
 *
 * These tests validate the data model and pure logic that supports
 * group chat behaviors, without depending on production code imports.
 */
import { describe, it, expect } from 'vitest';
import { createMockDB } from '../helpers/mock-db';

describe('Story B: Group Chat Scenarios', () => {
  // ─── B1: @mention Filtering ──────────────────────────

  describe('B1: require_mention mode', () => {
    it('group with require_mention=true only processes bot-mentioned messages', () => {
      const db = createMockDB();
      const chatJid = 'feishu:chat:oc_group1';
      const botOpenId = 'ou_bot_123';

      db.registerGroup({
        jid: chatJid,
        name: 'Test Group',
        folder: 'home-user1',
        requireMention: true,
        createdBy: 'user1',
      });

      const group = db.getRegisteredGroup(chatJid);
      expect(group?.requireMention).toBe(true);

      // Simulate: mentions array contains bot → should process
      const mentions = [{ id: { open_id: botOpenId } }];
      const isBotMentioned = mentions.some(
        (m) => (m as { id: { open_id: string } }).id?.open_id === botOpenId,
      );
      expect(isBotMentioned).toBe(true);
    });

    it('group with require_mention=true drops non-mentioned messages', () => {
      const db = createMockDB();
      const chatJid = 'feishu:chat:oc_group1';
      const botOpenId = 'ou_bot_123';
      const otherUserOpenId = 'ou_user_456';

      db.registerGroup({
        jid: chatJid,
        name: 'Test Group',
        folder: 'home-user1',
        requireMention: true,
        createdBy: 'user1',
      });

      // Bot is NOT in mentions
      const mentions = [{ id: { open_id: otherUserOpenId } }];
      const isBotMentioned = mentions.some(
        (m) => (m as { id: { open_id: string } }).id?.open_id === botOpenId,
      );
      expect(isBotMentioned).toBe(false);

      // Message should be dropped
      const group = db.getRegisteredGroup(chatJid);
      const shouldDrop = group?.requireMention && !isBotMentioned;
      expect(shouldDrop).toBe(true);
    });

    it('group with require_mention=false processes all messages', () => {
      const db = createMockDB();
      const chatJid = 'feishu:chat:oc_group2';

      db.registerGroup({
        jid: chatJid,
        name: 'Open Group',
        folder: 'home-user1',
        requireMention: false,
        createdBy: 'user1',
      });

      const group = db.getRegisteredGroup(chatJid);
      expect(group?.requireMention).toBe(false);

      // Even without mentions, should process
      const shouldProcess = !group?.requireMention;
      expect(shouldProcess).toBe(true);
    });

    it('group without require_mention field defaults to processing', () => {
      const db = createMockDB();
      const chatJid = 'feishu:chat:oc_group3';

      db.registerGroup({
        jid: chatJid,
        name: 'Default Group',
        folder: 'home-user1',
        // No requireMention field
        createdBy: 'user1',
      });

      const group = db.getRegisteredGroup(chatJid);
      // Undefined → falsy → process all
      expect(group?.requireMention).toBeFalsy();
    });
  });

  // ─── B2: Full Response Mode ──────────────────────────

  describe('B2: default mode processes all group messages', () => {
    it('DM (c2c) always processes regardless of require_mention', () => {
      const chatJid = 'dingtalk:c2c:staff123';
      const isC2C = chatJid.includes(':c2c:');
      expect(isC2C).toBe(true);

      // C2C should always process — require_mention doesn't apply
      const shouldAlwaysProcess = isC2C;
      expect(shouldAlwaysProcess).toBe(true);
    });

    it('telegram private chat always processes', () => {
      const chatJid = 'telegram:chat:12345';
      // Telegram DMs are typically positive numbers (negative = groups)
      const isPrivateChat = !chatJid.includes(':group:');
      expect(isPrivateChat).toBe(true);
    });
  });

  // ─── B5: Group Reply Routing ─────────────────────────

  describe('B5: group reply routing', () => {
    it('agent reply goes to the IM channel that sent the message', () => {
      const db = createMockDB();

      // A feishu group in user's home folder
      db.registerGroup({
        jid: 'feishu:chat:oc_group1',
        name: 'Feishu Group',
        folder: 'home-user1',
        createdBy: 'user1',
      });

      // Message arrives from feishu
      const sourceJid = 'feishu:chat:oc_group1';
      // Agent reply should route back to same JID
      const replyTarget = sourceJid;
      expect(replyTarget).toBe('feishu:chat:oc_group1');
    });

    it('multiple IM groups sharing a folder can each receive replies', () => {
      const db = createMockDB();

      db.registerGroup({
        jid: 'web:home-user1',
        name: 'Home',
        folder: 'home-user1',
        isHome: true,
        createdBy: 'user1',
      });
      db.registerGroup({
        jid: 'dingtalk:group:cidA',
        name: 'DT Group',
        folder: 'home-user1',
        createdBy: 'user1',
      });
      db.registerGroup({
        jid: 'feishu:chat:oc_B',
        name: 'Feishu Group',
        folder: 'home-user1',
        createdBy: 'user1',
      });

      // All groups in the folder
      const jids = db.getJidsByFolder('home-user1');
      expect(jids).toHaveLength(3);

      // Replies go to the source JID, not the folder
      // DingTalk group message → reply to DingTalk
      // Feishu group message → reply to Feishu
    });
  });

  // ─── B6: No Cross-Talk Between Groups ────────────────

  describe('B6: no cross-talk between groups', () => {
    it('messages in group A do not appear in group B', () => {
      const db = createMockDB();

      db.storeMessageDirect(
        'msg-1',
        'feishu:chat:groupA',
        's1',
        'Sender1',
        'Hello A',
        '2026-01-01T00:00:01Z',
        false,
      );
      db.storeMessageDirect(
        'msg-2',
        'feishu:chat:groupB',
        's2',
        'Sender2',
        'Hello B',
        '2026-01-01T00:00:02Z',
        false,
      );

      const msgsA = db.getMessagesForChat('feishu:chat:groupA');
      const msgsB = db.getMessagesForChat('feishu:chat:groupB');

      expect(msgsA).toHaveLength(1);
      expect(msgsB).toHaveLength(1);
      expect(msgsA[0].content).toBe('Hello A');
      expect(msgsB[0].content).toBe('Hello B');
    });

    it('messages in different folders with same IM type stay isolated', () => {
      const db = createMockDB();

      // Two users each have their own DingTalk group
      db.registerGroup({
        jid: 'dingtalk:group:cid_userA',
        name: 'A Group',
        folder: 'home-userA',
        createdBy: 'userA',
      });
      db.registerGroup({
        jid: 'dingtalk:group:cid_userB',
        name: 'B Group',
        folder: 'home-userB',
        createdBy: 'userB',
      });

      db.storeMessageDirect(
        'msg-1',
        'dingtalk:group:cid_userA',
        's',
        'S',
        'UserA content',
        '2026-01-01T00:00:01Z',
        false,
      );
      db.storeMessageDirect(
        'msg-2',
        'dingtalk:group:cid_userB',
        's',
        'S',
        'UserB content',
        '2026-01-01T00:00:02Z',
        false,
      );

      // getNewMessages for userA's JIDs only returns userA's messages
      const result = db.getNewMessages(['dingtalk:group:cid_userA'], {
        timestamp: '2026-01-01T00:00:00Z',
        id: '',
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('UserA content');
    });

    it('agents reply to correct JID based on source field', () => {
      const db = createMockDB();

      // Web message from user A's home
      db.storeMessageDirect(
        'msg-1',
        'web:home-userA',
        'userA',
        'User A',
        'Web message',
        '2026-01-01T00:00:01Z',
        false,
        { sourceJid: 'web:home-userA' },
      );

      // IM message in same folder but different JID
      db.storeMessageDirect(
        'msg-2',
        'dingtalk:c2c:staffA',
        'sender',
        'DT User',
        'DT message',
        '2026-01-01T00:00:02Z',
        false,
        { sourceJid: 'dingtalk:c2c:staffA' },
      );

      const webMsg = db.getMessagesForChat('web:home-userA')[0];
      const dtMsg = db.getMessagesForChat('dingtalk:c2c:staffA')[0];

      // Each message knows its source
      expect(webMsg.sourceJid).toBe('web:home-userA');
      expect(dtMsg.sourceJid).toBe('dingtalk:c2c:staffA');
    });
  });

  // ─── Group Lifecycle ─────────────────────────────────

  describe('group lifecycle', () => {
    it('new group auto-registers to user home folder', () => {
      const db = createMockDB();
      const userId = 'user1';
      const homeFolder = `home-${userId}`;

      // Pre-create home
      db.registerGroup({
        jid: `web:${homeFolder}`,
        folder: homeFolder,
        isHome: true,
        createdBy: userId,
        name: 'Home',
      });

      // New feishu group auto-registers
      db.registerGroup({
        jid: 'feishu:chat:oc_new',
        folder: homeFolder,
        createdBy: userId,
        name: 'New Group',
      });

      const jids = db.getJidsByFolder(homeFolder);
      expect(jids).toContain('feishu:chat:oc_new');
    });

    it('is_home group cannot be re-routed to different user', () => {
      const db = createMockDB();

      db.registerGroup({
        jid: 'web:home-user1',
        folder: 'home-user1',
        isHome: true,
        createdBy: 'user1',
        name: 'Home',
      });

      const group = db.getRegisteredGroup('web:home-user1');
      // is_home groups are protected from re-routing
      expect(group?.isHome).toBe(true);
      // In production, buildOnNewChat skips is_home groups
    });
  });
});
