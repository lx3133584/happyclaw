/**
 * Mock DB factory for integration tests.
 *
 * In-memory store that mimics the key DB functions used by IM message handling.
 * No real SQLite dependency.
 */

export interface StoredMessage {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  attachments?: string;
  sourceJid?: string;
}

export interface StoredGroup {
  jid: string;
  name: string;
  folder: string;
  isHome?: boolean;
  createdBy?: string;
  requireMention?: boolean;
  targetAgentId?: string;
  targetMainJid?: string;
  replyPolicy?: string;
}

export interface MockDBState {
  messages: StoredMessage[];
  chats: Map<string, { lastMessageTime: string; name?: string }>;
  registeredGroups: Map<string, StoredGroup>;
  jidsByFolder: Map<string, string[]>;
}

export function createMockDB() {
  const state: MockDBState = {
    messages: [],
    chats: new Map(),
    registeredGroups: new Map(),
    jidsByFolder: new Map(),
  };

  return {
    state,

    storeChatMetadata(chatJid: string, timestamp: string, name?: string): void {
      const existing = state.chats.get(chatJid);
      state.chats.set(chatJid, {
        lastMessageTime: timestamp,
        name: name ?? existing?.name,
      });
    },

    updateChatName(chatJid: string, name: string): void {
      const existing = state.chats.get(chatJid);
      state.chats.set(chatJid, { lastMessageTime: existing?.lastMessageTime ?? new Date().toISOString(), name });
    },

    storeMessageDirect(
      msgId: string,
      chatJid: string,
      sender: string,
      senderName: string,
      content: string,
      timestamp: string,
      isFromMe: boolean,
      opts?: { attachments?: string; sourceJid?: string },
    ): string {
      state.messages.push({
        id: msgId,
        chatJid,
        sender,
        senderName,
        content,
        timestamp,
        isFromMe,
        attachments: opts?.attachments,
        sourceJid: opts?.sourceJid,
      });
      return msgId;
    },

    getNewMessages(
      jids: string[],
      _cursor: { timestamp: string; id: string },
    ): { messages: StoredMessage[]; newCursor: { timestamp: string; id: string } } {
      const msgs = state.messages.filter(
        (m) => jids.includes(m.chatJid) && m.timestamp > _cursor.timestamp,
      );
      const last = msgs[msgs.length - 1];
      return {
        messages: msgs,
        newCursor: last
          ? { timestamp: last.timestamp, id: last.id }
          : _cursor,
      };
    },

    getRegisteredGroup(jid: string): StoredGroup | undefined {
      return state.registeredGroups.get(jid);
    },

    getAllRegisteredGroups(): Record<string, StoredGroup> {
      return Object.fromEntries(state.registeredGroups.entries());
    },

    getJidsByFolder(folder: string): string[] {
      return state.jidsByFolder.get(folder) ?? [];
    },

    // Test helper: register a group
    registerGroup(group: StoredGroup): void {
      state.registeredGroups.set(group.jid, group);
      const jids = state.jidsByFolder.get(group.folder) ?? [];
      if (!jids.includes(group.jid)) {
        jids.push(group.jid);
        state.jidsByFolder.set(group.folder, jids);
      }
    },

    // Test helper: get messages for a chat
    getMessagesForChat(chatJid: string): StoredMessage[] {
      return state.messages.filter((m) => m.chatJid === chatJid);
    },

    // Test helper: clear all data
    clear(): void {
      state.messages.length = 0;
      state.chats.clear();
      state.registeredGroups.clear();
      state.jidsByFolder.clear();
    },
  };
}
