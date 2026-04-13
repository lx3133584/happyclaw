/**
 * MQTT Connection Factory
 *
 * Lightweight MQTT integration for inter-agent communication.
 * Uses the 'mqtt' npm package (MQTT 3.1.1/5.0 client with auto-reconnect).
 *
 * ## Topic-as-Chat Model
 *
 * Each MQTT topic maps to a HappyClaw chat/conversation:
 *   - Topic "projects/alpha/chat" → JID "mqtt:projects~alpha~chat"
 *   - Agent replies are published back to the same topic
 *   - Multiple agents subscribing to the same topic = group chat
 *
 * By default, subscribes to "#" (all topics) so any incoming message
 * auto-registers a new chat — same behavior as other IM channels.
 *
 * ## JID Encoding
 *
 * MQTT topics contain "/" which conflicts with URL path routing (e.g.
 * GET /api/groups/:jid/messages). We encode "/" as "~" in JIDs:
 *   Topic "agents/broadcast" → JID "mqtt:agents~broadcast"
 *   Literal "~" in topics is escaped as "~~".
 *
 * ## Message Format
 *
 *   { "id": "uuid", "from": "agent-mini", "text": "hello", "ts": 1744201234567 }
 *
 * "from" is used for sender display name and self-echo filtering only.
 * The topic determines which chat the message belongs to.
 */
import crypto from 'crypto';
import mqtt from 'mqtt';
import type { MqttClient, IClientOptions } from 'mqtt';
import { storeChatMetadata, storeMessageDirect } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';

// ─── Topic ↔ JID Encoding ───────────────────────────────────────

/** Encode an MQTT topic for use in a JID (replace "/" with "~", escape literal "~" as "~~"). */
export function topicToJidSuffix(topic: string): string {
  return topic.replaceAll('~', '~~').replaceAll('/', '~');
}

/** Decode a JID suffix back to an MQTT topic. */
export function jidSuffixToTopic(suffix: string): string {
  // Use a placeholder to protect escaped "~~" during replacement
  return suffix
    .replaceAll('~~', '\x00')
    .replaceAll('~', '/')
    .replaceAll('\x00', '~');
}

// ─── Interfaces ──────────────────────────────────────────────────

export interface MqttConnectionConfig {
  brokerUrl: string;       // e.g. "mqtt://192.168.50.75:1883"
  clientId: string;        // unique agent name for self-echo filtering
  subscribeTopic: string;  // e.g. "#" (all) or "projects/#" (filtered)
  username?: string;
  password?: string;
}

export interface MqttConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  /** Resolve Sub-Agent routing: returns effectiveJid + agentId if bound */
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  /** Trigger conversation agent processing after routing */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
}

export interface MqttConnection {
  connect(opts: MqttConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  isConnected(): boolean;
}

// ─── Factory ─────────────────────────────────────────────────────

export function createMqttConnection(
  config: MqttConnectionConfig,
): MqttConnection {
  let client: MqttClient | null = null;
  let connected = false;

  // LRU message dedup (same pattern as telegram.ts / feishu.ts)
  const seen = new Map<string, number>();
  const DEDUP_TTL = 30 * 60 * 1000; // 30 min
  const DEDUP_MAX = 1000;

  function isDuplicate(key: string): boolean {
    const now = Date.now();
    // Lazy cleanup: remove expired entries from front
    for (const [k, t] of seen) {
      if (now - t > DEDUP_TTL) seen.delete(k);
      else break;
    }
    // FIFO eviction if size exceeded
    if (seen.size >= DEDUP_MAX) {
      const firstKey = seen.keys().next().value;
      if (firstKey) seen.delete(firstKey);
    }
    if (seen.has(key)) return true;
    seen.delete(key); // refresh position
    seen.set(key, now);
    return false;
  }

  return {
    async connect(opts: MqttConnectOpts): Promise<boolean> {
      try {
        const connectOpts: IClientOptions = {
          clientId:
            config.clientId + '-' + Math.random().toString(36).slice(2, 8),
          clean: true,
          reconnectPeriod: 5000,
          connectTimeout: 10_000,
        };
        if (config.username) connectOpts.username = config.username;
        if (config.password) connectOpts.password = config.password;

        client = mqtt.connect(config.brokerUrl, connectOpts);

        return new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => {
            logger.warn({ broker: config.brokerUrl }, 'MQTT connect timeout');
            client!.end(true);
            resolve(false);
          }, 15_000);

          client!.on('connect', () => {
            clearTimeout(timeout);
            connected = true;
            logger.info(
              { broker: config.brokerUrl, topic: config.subscribeTopic },
              'MQTT connected',
            );

            // Subscribe to configured topic (default "#" = all topics)
            client!.subscribe(config.subscribeTopic, { qos: 0 }, (err: Error | null) => {
              if (err) {
                logger.error({ err }, 'MQTT subscribe failed');
              } else {
                logger.info(
                  { topic: config.subscribeTopic },
                  'MQTT subscribed',
                );
              }
            });

            opts.onReady?.();
            resolve(true);
          });

          client!.on('error', (err: Error) => {
            clearTimeout(timeout);
            logger.error({ err }, 'MQTT connection error');
            client!.end(true);
            client = null;
            resolve(false);
          });

          client!.on('message', (topic: string, payload: Buffer) => {
            try {
              const raw = payload.toString();

              // Try JSON format: {"id":"...","from":"...","text":"...","ts":...}
              // Fall back to plain text
              let msgId: string | undefined;
              let senderName: string;
              let text: string;
              let ts: number | undefined;

              try {
                const data = JSON.parse(raw) as {
                  id?: string;
                  from?: string;
                  text?: string;
                  ts?: number;
                };
                msgId = data.id;
                senderName = data.from || 'unknown';
                text = data.text || raw;
                ts = data.ts;
              } catch {
                // Plain text message
                senderName = 'unknown';
                text = raw;
              }

              // Self-echo filtering: drop messages from ourselves
              if (senderName === config.clientId) return;

              // Dedup: prefer message id, fall back to content hash
              const dedupKey = msgId || `${topic}:${senderName}:${ts || ''}:${text.slice(0, 50)}`;
              if (isDuplicate(dedupKey)) return;

              // Ignore messages before reconnect
              if (
                opts.ignoreMessagesBefore &&
                ts &&
                ts < opts.ignoreMessagesBefore
              )
                return;

              logger.info({ topic, from: senderName }, 'MQTT message received');

              // Topic-as-Chat: the topic determines the chat, not the sender
              const chatJid = `mqtt:${topicToJidSuffix(topic)}`;
              const chatName = topic; // Display the raw topic as chat name
              const timestamp = new Date(ts || Date.now()).toISOString();
              const storedMsgId = crypto.randomUUID();

              // Check for slash commands
              if (text.startsWith('/') && opts.onCommand) {
                opts.onNewChat(chatJid, chatName);
                storeChatMetadata(chatJid, timestamp, chatName);
                storeMessageDirect(
                  storedMsgId,
                  chatJid,
                  chatJid,
                  senderName,
                  text,
                  timestamp,
                  false,
                );
                void opts.onCommand(chatJid, text).catch((err: unknown) => {
                  logger.warn({ err, chatJid }, 'MQTT command handler failed');
                });
                return;
              }

              // Auto-register chat (topic → chat)
              opts.onNewChat(chatJid, chatName);

              // Resolve Sub-Agent routing (same pattern as telegram.ts)
              const agentRouting = opts.resolveEffectiveChatJid?.(chatJid);
              const targetJid = agentRouting?.effectiveJid ?? chatJid;

              // Store message under targetJid (may be virtual JID for Sub-Agent)
              storeChatMetadata(targetJid, timestamp, chatName);
              storeMessageDirect(
                storedMsgId,
                targetJid,
                chatJid,
                senderName,
                text,
                timestamp,
                false,
                { sourceJid: chatJid },
              );

              // Notify message polling
              notifyNewImMessage();

              // Broadcast to web clients
              broadcastNewMessage(
                targetJid,
                {
                  id: storedMsgId,
                  chat_jid: targetJid,
                  source_jid: chatJid,
                  sender: chatJid,
                  sender_name: senderName,
                  content: text,
                  timestamp,
                  is_from_me: false,
                },
                agentRouting?.agentId ?? undefined,
              );

              // Trigger conversation agent if routed to Sub-Agent
              if (agentRouting?.agentId) {
                opts.onAgentMessage?.(chatJid, agentRouting.agentId);
                logger.info(
                  { chatJid, targetJid, agentId: agentRouting.agentId, from: senderName },
                  'MQTT message routed to conversation agent',
                );
              }
            } catch (err) {
              logger.warn({ err, topic }, 'Failed to process MQTT message');
            }
          });

          client!.on('close', () => {
            connected = false;
            logger.info('MQTT disconnected');
          });

          client!.on('reconnect', () => {
            logger.info('MQTT reconnecting...');
          });
        });
      } catch (err) {
        logger.error({ err }, 'MQTT connection failed');
        return false;
      }
    },

    async disconnect(): Promise<void> {
      if (!client) return;
      return new Promise<void>((resolve) => {
        client!.end(false, {}, () => {
          connected = false;
          client = null;
          resolve();
        });
      });
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!client || !connected) {
        logger.warn({ chatId }, 'MQTT not connected, skip publishing');
        return;
      }
      // chatId is the JID suffix (topic-encoded); decode back to real topic
      const topic = jidSuffixToTopic(chatId);
      const payload = JSON.stringify({
        id: crypto.randomUUID(),
        from: config.clientId,
        text,
        ts: Date.now(),
      });
      client.publish(topic, payload, { qos: 0 }, (err?: Error | null) => {
        if (err) {
          logger.error({ err, topic }, 'MQTT publish failed');
        }
      });
    },

    isConnected(): boolean {
      return connected;
    },
  };
}
