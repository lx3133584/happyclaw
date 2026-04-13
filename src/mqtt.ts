/**
 * MQTT Connection Factory
 *
 * Lightweight MQTT integration for inter-agent communication.
 * Uses the 'mqtt' npm package (MQTT 3.1.1/5.0 client with auto-reconnect).
 *
 * Message format on the wire:
 *   { "id": "uuid", "from": "agent-mini", "text": "hello", "ts": 1744201234567 }
 *
 * Topic convention:
 *   agents/{agent-name}/inbox   — direct message to a specific agent
 *   agents/broadcast            — broadcast to all agents
 */
import crypto from 'crypto';
import mqtt from 'mqtt';
import type { MqttClient, IClientOptions } from 'mqtt';
import { storeChatMetadata, storeMessageDirect } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';

// ─── Interfaces ──────────────────────────────────────────────────

export interface MqttConnectionConfig {
  brokerUrl: string;       // e.g. "mqtt://192.168.50.75:1883"
  clientId: string;        // unique agent name, e.g. "agent-mini-happyclaw"
  subscribeTopic: string;  // e.g. "agents/agent-mini-happyclaw/#"
  username?: string;
  password?: string;
}

export interface MqttConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
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
            resolve(false);
          }, 15_000);

          client!.on('connect', () => {
            clearTimeout(timeout);
            connected = true;
            logger.info(
              { broker: config.brokerUrl, topic: config.subscribeTopic },
              'MQTT connected',
            );

            // Subscribe to configured topic
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

            // Also subscribe to broadcast
            client!.subscribe('agents/broadcast', { qos: 0 });

            opts.onReady?.();
            resolve(true);
          });

          client!.on('error', (err: Error) => {
            clearTimeout(timeout);
            logger.error({ err }, 'MQTT connection error');
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
                // Plain text message — extract sender from topic if possible
                const parts = topic.split('/');
                senderName = parts.length >= 2 ? parts[1] : 'unknown';
                text = raw;
              }

              // Self-echo filtering: drop messages from ourselves
              if (senderName === config.clientId) return;

              // Dedup: prefer message id, fall back to content hash
              const dedupKey = msgId || `${senderName}:${ts || ''}:${text.slice(0, 50)}`;
              if (isDuplicate(dedupKey)) return;

              // Ignore messages before reconnect
              if (
                opts.ignoreMessagesBefore &&
                ts &&
                ts < opts.ignoreMessagesBefore
              )
                return;

              logger.info({ topic, from: senderName }, 'MQTT message received');

              const senderJid = `mqtt:${senderName}`;
              const timestamp = new Date(ts || Date.now()).toISOString();
              const storedMsgId = crypto.randomUUID();

              // Check for slash commands
              if (text.startsWith('/') && opts.onCommand) {
                void opts.onCommand(senderJid, text).then((reply) => {
                  if (reply) {
                    // Command handled — store both the command and reply
                    storeChatMetadata(senderJid, timestamp, senderName);
                    storeMessageDirect(
                      storedMsgId,
                      senderJid,
                      senderJid,
                      senderName,
                      text,
                      timestamp,
                      false,
                    );
                  }
                });
                return;
              }

              // Auto-register chat
              opts.onNewChat(senderJid, senderName);

              // Store message in database
              storeChatMetadata(senderJid, timestamp, senderName);
              storeMessageDirect(
                storedMsgId,
                senderJid,
                senderJid,
                senderName,
                text,
                timestamp,
                false,
              );

              // Notify message polling
              notifyNewImMessage();

              // Broadcast to web clients
              broadcastNewMessage(senderJid, {
                id: storedMsgId,
                chat_jid: senderJid,
                sender: senderJid,
                sender_name: senderName,
                content: text,
                timestamp,
                is_from_me: false,
              });
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
      if (client) {
        return new Promise<void>((resolve) => {
          client!.end(false, {}, () => {
            connected = false;
            client = null;
            resolve();
          });
        });
      }
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!client || !connected) {
        logger.warn({ chatId }, 'MQTT not connected, skip publishing');
        return;
      }
      const topic = `agents/${chatId}/inbox`;
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
