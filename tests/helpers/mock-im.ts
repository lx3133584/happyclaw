/**
 * Mock IM Channel factory for integration tests.
 *
 * Records all sendMessage/sendFile/sendImage calls so tests can assert
 * on what was sent, without connecting to any real IM service.
 */
import type { IMChannel, IMChannelConnectOpts } from '../../src/im-channel';

export interface RecordedMessage {
  chatId: string;
  text: string;
  localImagePaths?: string[];
}

export interface RecordedFile {
  chatId: string;
  filePath: string;
  fileName: string;
}

export interface RecordedImage {
  chatId: string;
  imageBuffer: Buffer;
  mimeType: string;
  caption?: string;
  fileName?: string;
}

export interface MockIMChannelState {
  sentMessages: RecordedMessage[];
  sentFiles: RecordedFile[];
  sentImages: RecordedImage[];
  connected: boolean;
  connectCalls: number;
  disconnectCalls: number;
  setTypingCalls: { chatId: string; isTyping: boolean }[];
}

export function createMockIMChannel(
  channelType: string = 'mock',
): IMChannel & { state: MockIMChannelState } {
  const state: MockIMChannelState = {
    sentMessages: [],
    sentFiles: [],
    sentImages: [],
    connected: false,
    connectCalls: 0,
    disconnectCalls: 0,
    setTypingCalls: [],
  };

  let connectOpts: IMChannelConnectOpts | undefined;

  return {
    state,
    channelType,

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      state.connectCalls++;
      connectOpts = opts;
      state.connected = true;
      opts.onReady?.();
      return true;
    },

    async disconnect(): Promise<void> {
      state.disconnectCalls++;
      state.connected = false;
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      state.sentMessages.push({ chatId, text, localImagePaths });
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      state.sentFiles.push({ chatId, filePath, fileName });
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      state.sentImages.push({
        chatId,
        imageBuffer,
        mimeType,
        caption,
        fileName,
      });
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      state.setTypingCalls.push({ chatId, isTyping });
    },

    isConnected(): boolean {
      return state.connected;
    },

    // Simulate incoming message by calling the onMessage callback
    simulateMessage(chatJid: string, text: string, senderName: string): void {
      connectOpts?.onMessage?.(chatJid, text, senderName);
    },

    // Simulate new chat callback
    simulateNewChat(chatJid: string, chatName: string): void {
      connectOpts?.onNewChat?.(chatJid, chatName);
    },
  } as IMChannel & { state: MockIMChannelState };
}
