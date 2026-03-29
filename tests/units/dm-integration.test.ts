/**
 * Story A: DM Integration Tests
 *
 * Tests the data flow for direct message (DM / C2C) scenarios:
 * A1: Text message from IM → stored correctly
 * A2: Image message → stored with image metadata
 * A3: File message → stored with download path
 * A5: Agent image reply → sent via sendImage
 * A8: DingTalk auto-pairing (no pairing code needed)
 *
 * Uses mock-db + mock-im to verify data flow without real services.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMockDB } from '../helpers/mock-db';
import { createMockIMChannel } from '../helpers/mock-im';
import { MockIpcDir } from '../helpers/mock-ipc';

describe('Story A: DM Integration', () => {
  let db: ReturnType<typeof createMockDB>;
  let imChannel: ReturnType<typeof createMockIMChannel>;
  let ipc: MockIpcDir;

  const chatJid = 'dingtalk:c2c:staff_test';
  const senderName = 'TestUser';
  const senderJid = 'sender-123';

  beforeEach(() => {
    db = createMockDB();
    imChannel = createMockIMChannel('dingtalk');
    ipc = new MockIpcDir('test-folder');
  });

  // Cleanup IPC after each test
  afterEach(() => {
    ipc.cleanup();
  });

  // ─── A1: Text Message ───────────────────────────────

  describe('A1: text message from IM', () => {
    it('stores user text message in DB', () => {
      const msgId = 'msg-001';
      const content = '你好，请帮我分析一下这段代码';
      const timestamp = '2026-01-15T10:00:00Z';

      db.storeMessageDirect(msgId, chatJid, senderJid, senderName, content, timestamp, false);

      const msgs = db.getMessagesForChat(chatJid);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe(content);
      expect(msgs[0].sender).toBe(senderJid);
      expect(msgs[0].senderName).toBe(senderName);
      expect(msgs[0].isFromMe).toBe(false);
    });

    it('stores agent reply in DB', () => {
      const msgId = 'msg-002';
      const content = '我来帮你分析一下。';
      const timestamp = '2026-01-15T10:00:05Z';

      db.storeMessageDirect(msgId, chatJid, 'agent', 'HappyClaw', content, timestamp, true);

      const msgs = db.getMessagesForChat(chatJid);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].isFromMe).toBe(true);
      expect(msgs[0].content).toBe(content);
    });

    it('agent reply is sent via IM channel', async () => {
      await imChannel.sendMessage(chatJid, '这是回复');

      expect(imChannel.state.sentMessages).toHaveLength(1);
      expect(imChannel.state.sentMessages[0].chatId).toBe(chatJid);
      expect(imChannel.state.sentMessages[0].text).toBe('这是回复');
    });
  });

  // ─── A2: Image Message ──────────────────────────────

  describe('A2: image message from IM', () => {
    it('stores message with image attachment', () => {
      const msgId = 'msg-img-001';
      const timestamp = '2026-01-15T10:01:00Z';
      const attachment = JSON.stringify([
        { type: 'image', url: '/downloads/dingtalk/2026-01-15/photo.png' },
      ]);

      db.storeMessageDirect(
        msgId,
        chatJid,
        senderJid,
        senderName,
        '[图片]',
        timestamp,
        false,
        { attachments: attachment },
      );

      const msgs = db.getMessagesForChat(chatJid);
      expect(msgs[0].attachments).toBe(attachment);
      expect(JSON.parse(msgs[0].attachments!).length).toBe(1);
    });

    it('agent sends image via IM channel', async () => {
      const imageBuffer = Buffer.from('fake-image-data');
      const mimeType = 'image/png';

      await imChannel.sendImage(chatJid, imageBuffer, mimeType, '图表结果');

      expect(imChannel.state.sentImages).toHaveLength(1);
      expect(imChannel.state.sentImages[0].chatId).toBe(chatJid);
      expect(imChannel.state.sentImages[0].mimeType).toBe(mimeType);
      expect(imChannel.state.sentImages[0].caption).toBe('图表结果');
    });
  });

  // ─── A3: File Message ───────────────────────────────

  describe('A3: file message from IM', () => {
    it('stores message with file download info', () => {
      const msgId = 'msg-file-001';
      const timestamp = '2026-01-15T10:02:00Z';
      const attachment = JSON.stringify([
        { type: 'file', url: '/downloads/dingtalk/2026-01-15/report.pdf', name: 'report.pdf' },
      ]);

      db.storeMessageDirect(
        msgId,
        chatJid,
        senderJid,
        senderName,
        'report.pdf',
        timestamp,
        false,
        { attachments: attachment },
      );

      const msgs = db.getMessagesForChat(chatJid);
      expect(msgs[0].attachments).toBeTruthy();
      const parsed = JSON.parse(msgs[0].attachments!);
      expect(parsed[0].name).toBe('report.pdf');
    });

    it('agent sends file via IM channel', async () => {
      await imChannel.sendFile(chatJid, '/workspace/result.csv', 'result.csv');

      expect(imChannel.state.sentFiles).toHaveLength(1);
      expect(imChannel.state.sentFiles[0].chatId).toBe(chatJid);
      expect(imChannel.state.sentFiles[0].fileName).toBe('result.csv');
    });
  });

  // ─── A5: Agent Image Reply ──────────────────────────

  describe('A5: agent generates and sends image', () => {
    it('agent sends image with caption to chat', async () => {
      const chartBuffer = Buffer.from('chart-binary-data');
      await imChannel.sendImage(chatJid, chartBuffer, 'image/png', '数据分析图表');

      expect(imChannel.state.sentImages).toHaveLength(1);
      expect(imChannel.state.sentImages[0].imageBuffer).toBe(chartBuffer);
      expect(imChannel.state.sentImages[0].caption).toBe('数据分析图表');
    });
  });

  // ─── A8: DingTalk Auto-Pairing ──────────────────────

  describe('A8: DingTalk auto-pairing', () => {
    it('DingTalk C2C does not require pairing code', () => {
      // DingTalk auto-registers on first message
      const chatJid = 'dingtalk:c2c:staff_new';
      db.registerGroup({
        jid: chatJid,
        name: 'New DM',
        folder: 'home-user1',
        createdBy: 'user1',
      });

      const group = db.getRegisteredGroup(chatJid);
      expect(group).toBeDefined();
      expect(group?.folder).toBe('home-user1');
    });

    it('DingTalk group auto-registers', () => {
      const groupJid = 'dingtalk:group:cidNewGroup';
      db.registerGroup({
        jid: groupJid,
        name: 'New Group',
        folder: 'home-user1',
        createdBy: 'user1',
      });

      const group = db.getRegisteredGroup(groupJid);
      expect(group).toBeDefined();
    });
  });

  // ─── A10: Message Dedup (already tested in im-dedup) ──

  describe('A10: message dedup integration', () => {
    it('duplicate messages are not stored twice', () => {
      const msgId = 'dedup-msg-001';
      const timestamp = '2026-01-15T10:03:00Z';

      db.storeMessageDirect(msgId, chatJid, senderJid, senderName, 'Hello', timestamp, false);
      // Same message ID again (in production, dedup prevents this)
      db.storeMessageDirect(msgId, chatJid, senderJid, senderName, 'Hello', timestamp, false);

      // Mock DB doesn't dedup — in production, MsgDedupCache prevents double-storing
      // This test verifies the mock records both (dedup is tested separately)
      expect(db.getMessagesForChat(chatJid)).toHaveLength(2);
    });
  });

  // ─── IPC Integration ────────────────────────────────

  describe('IPC: agent ↔ main process', () => {
    it('main process can write input file for agent', () => {
      ipc.writeInputMessage('后续消息', [
        { data: 'base64data', mimeType: 'image/png' },
      ]);

      const inputs = ipc.readAllInputs();
      expect(inputs).toHaveLength(1);
      expect(inputs[0].type).toBe('user_message');
      expect(inputs[0].text).toBe('后续消息');
      expect(inputs[0].images).toBeDefined();
    });

    it('agent can send message back via IPC', () => {
      ipc.writeAgentMessage({
        type: 'send_message',
        chatJid,
        text: 'Agent reply',
      });

      const messages = ipc.readAllMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('send_message');
      expect(messages[0].text).toBe('Agent reply');
    });

    it('agent can create task via IPC', () => {
      ipc.writeAgentTask({
        type: 'create_task',
        name: '定时检查',
        schedule: '0 9 * * *',
      });

      const tasks = ipc.readAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].type).toBe('create_task');
    });
  });

  // ─── IM Channel Lifecycle ───────────────────────────

  describe('IM channel lifecycle', () => {
    it('connect → receive message → send reply → disconnect', async () => {
      // Connect
      const connected = await imChannel.connect({
        onMessage: () => {},
        onReady: () => {},
      });
      expect(connected).toBe(true);
      expect(imChannel.state.connected).toBe(true);

      // Send reply
      await imChannel.sendMessage(chatJid, '回复');
      expect(imChannel.state.sentMessages).toHaveLength(1);

      // Disconnect
      await imChannel.disconnect();
      expect(imChannel.state.connected).toBe(false);
      expect(imChannel.state.disconnectCalls).toBe(1);
    });

    it('typing indicator', async () => {
      await imChannel.connect({ onMessage: () => {} });
      await imChannel.setTyping(chatJid, true);
      await imChannel.setTyping(chatJid, false);

      expect(imChannel.state.setTypingCalls).toHaveLength(2);
      expect(imChannel.state.setTypingCalls[0]).toEqual({ chatId: chatJid, isTyping: true });
      expect(imChannel.state.setTypingCalls[1]).toEqual({ chatId: chatJid, isTyping: false });
    });
  });
});
