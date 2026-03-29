/**
 * Test context factory - assembles mock DB + mock IM + mock IPC
 * into a coherent test context for story-based integration tests.
 */
import { createMockDB, type MockDBState } from './mock-db';
import {
  createMockIMChannel,
  type MockIMChannelState,
} from './mock-im';
import { MockIpcDir } from './mock-ipc';
import type { IMChannel } from '../../src/im-channel';

export interface TestContext {
  db: ReturnType<typeof createMockDB>;
  imChannel: IMChannel & { state: MockIMChannelState };
  ipc: MockIpcDir;
  folder: string;
  chatJid: string;
  senderJid: string;
  senderName: string;

  /** Register this chat as a known group */
  registerGroup(opts?: { isHome?: boolean; requireMention?: boolean }): void;

  /** Simulate an incoming IM message through the channel */
  simulateIncomingMessage(
    text: string,
    opts?: { senderName?: string; chatJid?: string },
  ): void;
}

export function createTestContext(opts?: {
  channelType?: string;
  folder?: string;
  chatJid?: string;
}): TestContext {
  const folder = opts?.folder ?? 'test-group';
  const chatJid =
    opts?.chatJid ?? `${opts?.channelType ?? 'dingtalk'}:c2c:user-123`;
  const senderJid = 'sender-456';
  const senderName = 'TestUser';

  const db = createMockDB();
  const imChannel = createMockIMChannel(opts?.channelType ?? 'dingtalk');
  const ipc = new MockIpcDir(folder);

  return {
    db,
    imChannel,
    ipc,
    folder,
    chatJid,
    senderJid,
    senderName,

    registerGroup(groupOpts?: { isHome?: boolean; requireMention?: boolean }) {
      db.registerGroup({
        jid: chatJid,
        name: `Test Chat (${chatJid.slice(0, 12)})`,
        folder,
        isHome: groupOpts?.isHome ?? false,
        requireMention: groupOpts?.requireMention,
      });
    },

    simulateIncomingMessage(
      text: string,
      msgOpts?: { senderName?: string; chatJid?: string },
    ) {
      imChannel
        .simulateMessage(
          msgOpts?.chatJid ?? chatJid,
          text,
          msgOpts?.senderName ?? senderName,
        );
    },
  };
}
