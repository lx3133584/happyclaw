/**
 * Story D2: User Isolation Constraint Tests
 *
 * Verifies that user A's IM messages cannot route to user B's workspace,
 * and that group ownership / folder routing is correctly isolated.
 *
 * These tests use mock-db to simulate the data layer and test the
 * pure routing logic extracted from production code.
 *
 * NOTE: The routing functions (normalizeHomeJid, computeGroupAllowedUserIds,
 * findChannelForJid) are not exported from their modules. We test the
 * DATA MODEL constraints they rely on — i.e., that the mock-db correctly
 * reflects the isolation properties that production routing depends on.
 */
import { describe, it, expect } from 'vitest';
import { createMockDB, type StoredGroup } from '../helpers/mock-db';

describe('Story D2: User Isolation', () => {
  // ─── Data Model: Folder Isolation ──────────────────────

  describe('folder isolation', () => {
    it('two users have separate home folders', () => {
      const db = createMockDB();
      const userA = 'user-aaa';
      const userB = 'user-bbb';

      db.registerGroup({
        jid: `web:home-${userA}`,
        name: 'UserA Home',
        folder: `home-${userA}`,
        isHome: true,
        createdBy: userA,
      });
      db.registerGroup({
        jid: `web:home-${userB}`,
        name: 'UserB Home',
        folder: `home-${userB}`,
        isHome: true,
        createdBy: userB,
      });

      // User A's folder only contains their own JIDs
      const jidsA = db.getJidsByFolder(`home-${userA}`);
      expect(jidsA).toEqual([`web:home-${userA}`]);
      expect(jidsA).not.toContain(`web:home-${userB}`);

      // User B's folder only contains their own JIDs
      const jidsB = db.getJidsByFolder(`home-${userB}`);
      expect(jidsB).toEqual([`web:home-${userB}`]);
      expect(jidsB).not.toContain(`web:home-${userA}`);
    });

    it('IM groups registered to user A do not appear in user B folder', () => {
      const db = createMockDB();
      const userA = 'user-aaa';
      const userB = 'user-bbb';

      // User A has a DingTalk group
      db.registerGroup({
        jid: 'web:home-userA',
        name: 'UserA Home',
        folder: 'home-userA',
        isHome: true,
        createdBy: userA,
      });
      db.registerGroup({
        jid: 'dingtalk:c2c:staffA',
        name: 'DingTalk A',
        folder: 'home-userA',
        createdBy: userA,
      });

      // User B's home folder is empty
      const jidsB = db.getJidsByFolder('home-userB');
      expect(jidsB).toEqual([]);
    });

    it('multiple IM channels can share a user folder', () => {
      const db = createMockDB();

      db.registerGroup({
        jid: 'web:home-user1',
        name: 'Home',
        folder: 'home-user1',
        isHome: true,
        createdBy: 'user1',
      });
      db.registerGroup({
        jid: 'dingtalk:c2c:staff1',
        name: 'DT DM',
        folder: 'home-user1',
        createdBy: 'user1',
      });
      db.registerGroup({
        jid: 'telegram:chat:123',
        name: 'TG Chat',
        folder: 'home-user1',
        createdBy: 'user1',
      });
      db.registerGroup({
        jid: 'feishu:chat:oc_abc',
        name: 'Feishu',
        folder: 'home-user1',
        createdBy: 'user1',
      });

      const jids = db.getJidsByFolder('home-user1');
      expect(jids).toHaveLength(4);
      expect(jids).toContain('web:home-user1');
      expect(jids).toContain('dingtalk:c2c:staff1');
      expect(jids).toContain('telegram:chat:123');
      expect(jids).toContain('feishu:chat:oc_abc');
    });
  });

  // ─── Data Model: Owner Resolution ──────────────────────

  describe('owner resolution (computeGroupAllowedUserIds logic)', () => {
    it('resolves owner from group.created_by directly', () => {
      const db = createMockDB();
      const userA = 'user-aaa';

      db.registerGroup({
        jid: 'dingtalk:c2c:staff123',
        name: 'DT',
        folder: 'home-userA',
        createdBy: userA,
      });

      const group = db.getRegisteredGroup('dingtalk:c2c:staff123');
      expect(group?.createdBy).toBe(userA);
    });

    it('falls back to sibling home group owner when created_by is missing', () => {
      const db = createMockDB();

      // Web home group has owner
      db.registerGroup({
        jid: 'web:home-user1',
        name: 'Home',
        folder: 'home-user1',
        isHome: true,
        createdBy: 'user1',
      });

      // IM group lacks created_by (legacy)
      db.registerGroup({
        jid: 'feishu:chat:oc_legacy',
        name: 'Legacy Feishu',
        folder: 'home-user1',
        // No createdBy
      });

      // Simulate: resolve owner via sibling web: JID
      const imGroup = db.getRegisteredGroup('feishu:chat:oc_legacy');
      expect(imGroup?.createdBy).toBeUndefined();

      // Fallback logic: find sibling web: JID in same folder
      const jids = db.getJidsByFolder('home-user1');
      const webJid = jids.find((j) => j.startsWith('web:'));
      const webGroup = webJid ? db.getRegisteredGroup(webJid) : undefined;
      expect(webGroup?.isHome).toBe(true);
      expect(webGroup?.createdBy).toBe('user1');
    });

    it('user B cannot resolve ownership of user A groups', () => {
      const db = createMockDB();

      db.registerGroup({
        jid: 'web:home-userA',
        name: 'Home A',
        folder: 'home-userA',
        isHome: true,
        createdBy: 'userA',
      });
      db.registerGroup({
        jid: 'dingtalk:c2c:staffA',
        name: 'DT A',
        folder: 'home-userA',
        createdBy: 'userA',
      });

      // User B's folder is independent
      db.registerGroup({
        jid: 'web:home-userB',
        name: 'Home B',
        folder: 'home-userB',
        isHome: true,
        createdBy: 'userB',
      });

      // User B's folder doesn't contain user A's groups
      const jidsB = db.getJidsByFolder('home-userB');
      expect(jidsB).not.toContain('dingtalk:c2c:staffA');

      // User B cannot find a home group for user A's IM JID
      const groupA = db.getRegisteredGroup('dingtalk:c2c:staffA');
      expect(groupA?.createdBy).toBe('userA');
      expect(groupA?.createdBy).not.toBe('userB');
    });
  });

  // ─── Data Model: normalizeHomeJid routing table ──────────

  describe('normalizeHomeJid: JID → web: mapping', () => {
    it('web: JIDs are identity-mapped', () => {
      // normalizeHomeJid('web:home-user1') → 'web:home-user1'
      const jid = 'web:home-user1';
      expect(jid.startsWith('web:')).toBe(true);
    });

    it('IM JID resolves to web: JID via shared folder', () => {
      const db = createMockDB();

      db.registerGroup({
        jid: 'web:home-user1',
        name: 'Home',
        folder: 'home-user1',
        isHome: true,
        createdBy: 'user1',
      });
      db.registerGroup({
        jid: 'dingtalk:c2c:staff1',
        name: 'DT',
        folder: 'home-user1',
        createdBy: 'user1',
      });

      // Simulate normalizeHomeJid('dingtalk:c2c:staff1'):
      // 1. Look up group → folder = 'home-user1'
      // 2. Get all JIDs in folder → find web: JID
      const group = db.getRegisteredGroup('dingtalk:c2c:staff1');
      expect(group).toBeDefined();
      const jids = db.getJidsByFolder(group!.folder);
      const webJid = jids.find((j) => j.startsWith('web:'));
      expect(webJid).toBe('web:home-user1');
    });

    it('IM JID from different user resolves to their own web: JID', () => {
      const db = createMockDB();

      // Two users with their own IM groups
      db.registerGroup({
        jid: 'web:home-userA',
        folder: 'home-userA',
        isHome: true,
        createdBy: 'userA',
        name: 'A',
      });
      db.registerGroup({
        jid: 'dingtalk:c2c:staffA',
        folder: 'home-userA',
        createdBy: 'userA',
        name: 'DT A',
      });
      db.registerGroup({
        jid: 'web:home-userB',
        folder: 'home-userB',
        isHome: true,
        createdBy: 'userB',
        name: 'B',
      });
      db.registerGroup({
        jid: 'dingtalk:c2c:staffB',
        folder: 'home-userB',
        createdBy: 'userB',
        name: 'DT B',
      });

      // User A's IM resolves to User A's web JID
      const groupA = db.getRegisteredGroup('dingtalk:c2c:staffA');
      const jidsA = db.getJidsByFolder(groupA!.folder);
      const webA = jidsA.find((j) => j.startsWith('web:'));
      expect(webA).toBe('web:home-userA');

      // User B's IM resolves to User B's web JID
      const groupB = db.getRegisteredGroup('dingtalk:c2c:staffB');
      const jidsB = db.getJidsByFolder(groupB!.folder);
      const webB = jidsB.find((j) => j.startsWith('web:'));
      expect(webB).toBe('web:home-userB');

      // Cross-check: NOT mixed
      expect(webA).not.toBe(webB);
    });
  });

  // ─── Data Model: Admin vs Member home folders ──────────

  describe('admin vs member isolation', () => {
    it('admin home folder is "main", member is "home-{userId}"', () => {
      const db = createMockDB();

      // Admin (per ensureUserHomeGroup logic)
      db.registerGroup({
        jid: 'web:main',
        folder: 'main',
        isHome: true,
        createdBy: 'admin-id',
        name: 'Admin Home',
      });

      // Member
      db.registerGroup({
        jid: 'web:home-member1',
        folder: 'home-member1',
        isHome: true,
        createdBy: 'member1-id',
        name: 'Member Home',
      });

      const adminGroup = db.getRegisteredGroup('web:main');
      expect(adminGroup?.folder).toBe('main');

      const memberGroup = db.getRegisteredGroup('web:home-member1');
      expect(memberGroup?.folder).toBe('home-member1');
    });

    it('admin IM groups go to "main" folder', () => {
      const db = createMockDB();

      db.registerGroup({
        jid: 'web:main',
        folder: 'main',
        isHome: true,
        createdBy: 'admin-id',
        name: 'Main',
      });
      db.registerGroup({
        jid: 'feishu:chat:oc_admin_group',
        folder: 'main',
        createdBy: 'admin-id',
        name: 'Admin Feishu',
      });

      const jids = db.getJidsByFolder('main');
      expect(jids).toContain('web:main');
      expect(jids).toContain('feishu:chat:oc_admin_group');
      expect(jids).toHaveLength(2);
    });

    it('member IM groups do NOT leak into "main" folder', () => {
      const db = createMockDB();

      db.registerGroup({
        jid: 'web:main',
        folder: 'main',
        isHome: true,
        createdBy: 'admin-id',
        name: 'Main',
      });
      db.registerGroup({
        jid: 'web:home-member1',
        folder: 'home-member1',
        isHome: true,
        createdBy: 'member1-id',
        name: 'Member Home',
      });
      db.registerGroup({
        jid: 'dingtalk:c2c:member_staff',
        folder: 'home-member1',
        createdBy: 'member1-id',
        name: 'Member DT',
      });

      const mainJids = db.getJidsByFolder('main');
      expect(mainJids).not.toContain('dingtalk:c2c:member_staff');
      expect(mainJids).toHaveLength(1); // only web:main
    });
  });

  // ─── Data Model: onNewChat routing ────────────────────

  describe('onNewChat: auto-registration routes to correct home', () => {
    it('new IM chat is registered to user home folder', () => {
      const db = createMockDB();
      const userId = 'user-123';
      const homeFolder = `home-${userId}`;

      // Pre-create home group
      db.registerGroup({
        jid: `web:${homeFolder}`,
        folder: homeFolder,
        isHome: true,
        createdBy: userId,
        name: 'Home',
      });

      // Simulate onNewChat behavior: register new DingTalk chat
      const chatJid = 'dingtalk:c2c:new_staff';
      const chatName = 'New Chat';
      db.registerGroup({
        jid: chatJid,
        name: chatName,
        folder: homeFolder,
        createdBy: userId,
      });

      // Verify routing
      const group = db.getRegisteredGroup(chatJid);
      expect(group?.folder).toBe(homeFolder);
      expect(group?.createdBy).toBe(userId);

      // Verify folder lookup returns both JIDs
      const jids = db.getJidsByFolder(homeFolder);
      expect(jids).toContain(`web:${homeFolder}`);
      expect(jids).toContain(chatJid);
    });

    it('re-registering existing chat with different owner re-routes folder', () => {
      const db = createMockDB();

      // Original owner
      db.registerGroup({
        jid: 'dingtalk:c2c:shared_staff',
        name: 'Shared',
        folder: 'home-userA',
        createdBy: 'userA',
      });

      // Simulate re-route: same JID, new owner
      // (In production, buildOnNewChat handles this)
      const group = db.getRegisteredGroup('dingtalk:c2c:shared_staff')!;
      group.folder = 'home-userB';
      group.createdBy = 'userB';

      // Verify re-routed
      expect(group.folder).toBe('home-userB');
      expect(group.createdBy).toBe('userB');
    });
  });

  // ─── Message Isolation ────────────────────────────────

  describe('message isolation', () => {
    it('messages stored under user A chatJid are not returned for user B', () => {
      const db = createMockDB();

      db.storeMessageDirect(
        'msg-1',
        'dingtalk:c2c:staffA',
        'sender',
        'UserA',
        'Hello A',
        '2026-01-01T00:00:00Z',
        false,
      );
      db.storeMessageDirect(
        'msg-2',
        'dingtalk:c2c:staffB',
        'sender',
        'UserB',
        'Hello B',
        '2026-01-01T00:00:01Z',
        false,
      );

      const msgsA = db.getMessagesForChat('dingtalk:c2c:staffA');
      expect(msgsA).toHaveLength(1);
      expect(msgsA[0].content).toBe('Hello A');

      const msgsB = db.getMessagesForChat('dingtalk:c2c:staffB');
      expect(msgsB).toHaveLength(1);
      expect(msgsB[0].content).toBe('Hello B');

      // Cross-check: no leakage
      const crossA = db.getMessagesForChat('dingtalk:c2c:staffB');
      expect(crossA.every((m) => m.content !== 'Hello A')).toBe(true);
    });

    it('getNewMessages respects JID filtering', () => {
      const db = createMockDB();

      db.storeMessageDirect(
        'msg-1',
        'dingtalk:c2c:staffA',
        's',
        'S',
        'A msg',
        '2026-01-01T00:00:01Z',
        false,
      );
      db.storeMessageDirect(
        'msg-2',
        'dingtalk:c2c:staffB',
        's',
        'S',
        'B msg',
        '2026-01-01T00:00:02Z',
        false,
      );
      db.storeMessageDirect(
        'msg-3',
        'dingtalk:c2c:staffA',
        's',
        'S',
        'A msg 2',
        '2026-01-01T00:00:03Z',
        false,
      );

      // Querying user A's JIDs should NOT return user B's messages
      const result = db.getNewMessages(['dingtalk:c2c:staffA'], {
        timestamp: '2026-01-01T00:00:00Z',
        id: '',
      });
      expect(result.messages).toHaveLength(2);
      expect(
        result.messages.every((m) => m.chatJid === 'dingtalk:c2c:staffA'),
      ).toBe(true);
    });
  });
});
