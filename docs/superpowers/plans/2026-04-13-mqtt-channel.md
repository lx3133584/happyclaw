# MQTT IM Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MQTT as a new IM channel so HappyClaw agents can communicate with external systems through an MQTT broker.

**Architecture:** Follows the existing IM channel pattern — connection factory (`src/mqtt.ts`) wrapped by IMChannel adapter (`src/im-channel.ts`), managed by `IMConnectionManager` (`src/im-manager.ts`), with encrypted per-user config storage, API routes, and a frontend settings card.

**Tech Stack:** `mqtt` npm package (MQTT 3.1.1/5.0 client), AES-256-GCM config encryption, Hono API routes, React settings card.

---

## File Structure

| File | Responsibility |
|------|---------------|
| **new** `src/mqtt.ts` | MQTT connection factory: connect/disconnect/publish, message dedup, self-echo filtering |
| `src/im-channel.ts` | New `createMqttChannel()` adapter wrapping MqttConnection into IMChannel |
| `src/im-manager.ts` | New `connectUserMQTT` / `disconnectUserMQTT` / `isMQTTConnected` methods |
| `src/runtime-config.ts` | Encrypted config read/write: `getUserMqttConfig` / `saveUserMqttConfig` |
| `src/schemas.ts` | `MqttConfigSchema` Zod validation + `'mqtt'` in notify_channels enum |
| `src/routes/config.ts` | GET/PUT/POST test routes for `/api/config/user-im/mqtt` |
| `src/index.ts` | Startup connection + hot-reload integration |
| `src/web-context.ts` | `isUserMQTTConnected` in WebDeps interface |
| `shared/channel-prefixes.ts` + 2 copies | `mqtt: 'mqtt:'` prefix registration |
| **new** `web/src/components/settings/MQTTChannelCard.tsx` | Frontend config card |
| `web/src/components/settings/UserChannelsSection.tsx` | Import + render MQTTChannelCard |
| `web/src/components/settings/channel-meta.tsx` | MQTT label, color, icon |
| `web/src/components/settings/BindingsSection.tsx` | `'mqtt'` in ChannelFilter type |
| `web/src/utils/task-utils.ts` | `'mqtt'` in CHANNEL_OPTIONS |

---

### Task 1: Install mqtt dependency and register channel prefix

**Files:**
- Modify: `package.json` (add `mqtt` dependency)
- Modify: `shared/channel-prefixes.ts:6` (add mqtt prefix)
- Modify: `src/channel-prefixes.ts:6` (sync copy)
- Modify: `container/agent-runner/src/channel-prefixes.ts:6` (sync copy)

- [ ] **Step 1: Install mqtt package**

```bash
npm install mqtt
```

- [ ] **Step 2: Add mqtt prefix to shared/channel-prefixes.ts**

In `shared/channel-prefixes.ts`, after the `discord: 'discord:',` line (line 8), add:

```typescript
  mqtt: 'mqtt:',
```

- [ ] **Step 3: Sync prefix to src/channel-prefixes.ts**

In `src/channel-prefixes.ts`, after the `discord: 'discord:',` line, add:

```typescript
  mqtt: 'mqtt:',
```

- [ ] **Step 4: Sync prefix to container/agent-runner/src/channel-prefixes.ts**

In `container/agent-runner/src/channel-prefixes.ts`, after the `discord: 'discord:',` line, add:

```typescript
  mqtt: 'mqtt:',
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json shared/channel-prefixes.ts src/channel-prefixes.ts container/agent-runner/src/channel-prefixes.ts
git commit -m "功能(mqtt): 安装 mqtt 依赖 + 注册 channel prefix"
```

---

### Task 2: Create MQTT connection factory

**Files:**
- Create: `src/mqtt.ts`

- [ ] **Step 1: Create src/mqtt.ts**

```typescript
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
```

- [ ] **Step 2: Verify TypeScript compiles (mqtt.ts only)**

```bash
npx tsc --noEmit src/mqtt.ts 2>&1 | head -20
```

Expected: No errors (or only errors from other files, not mqtt.ts).

- [ ] **Step 3: Commit**

```bash
git add src/mqtt.ts
git commit -m "功能(mqtt): MQTT 连接工厂 — 收发消息、自回环过滤、去重"
```

---

### Task 3: Add IMChannel adapter and IMConnectionManager methods

**Files:**
- Modify: `src/im-channel.ts` (add `createMqttChannel` after line 693, before Discord adapter)
- Modify: `src/im-manager.ts` (add imports, config interface, connect/disconnect/status methods)

- [ ] **Step 1: Add MQTT import to im-channel.ts**

At the top of `src/im-channel.ts`, after the DingTalk import block, add:

```typescript
import {
  createMqttConnection,
  type MqttConnectionConfig,
} from './mqtt.js';
```

- [ ] **Step 2: Add createMqttChannel adapter to im-channel.ts**

After the `createDingTalkChannel` function closing brace (line 693), before the `// ─── Discord Adapter` comment (line 695), insert:

```typescript

// ─── MQTT Adapter ────────────────────────────────────────────────

export function createMqttChannel(
  config: MqttConnectionConfig,
): IMChannel {
  let inner: ReturnType<typeof createMqttConnection> | null = null;

  const channel: IMChannel = {
    channelType: 'mqtt',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createMqttConnection(config);
      try {
        const ok = await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          onCommand: opts.onCommand,
        });
        if (!ok) {
          inner = null;
        }
        return ok;
      } catch (err) {
        logger.error({ err }, 'MQTT channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      if (inner) {
        await inner.disconnect();
        inner = null;
      }
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'MQTT channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text);
    },

    async setTyping(_chatId: string, _isTyping: boolean): Promise<void> {
      // MQTT does not support typing indicators
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },
  };

  return channel;
}
```

- [ ] **Step 3: Add MQTT imports to im-manager.ts**

In `src/im-manager.ts`, add the import for `createMqttChannel` in the existing import block from `'./im-channel.js'` (line 8-19). Add `createMqttChannel` to the import list:

```typescript
  createMqttChannel,
```

Add the type import after the Discord import (line 25):

```typescript
import type { MqttConnectionConfig } from './mqtt.js';
```

- [ ] **Step 4: Add MqttConnectConfig interface to im-manager.ts**

After the `DiscordConnectConfig` interface (after line 74), add:

```typescript

export interface MqttConnectConfig {
  brokerUrl: string;
  clientId: string;
  subscribeTopic: string;
  username?: string;
  password?: string;
  enabled?: boolean;
}
```

- [ ] **Step 5: Add connectUserMQTT, disconnectUserMQTT, isMQTTConnected to im-manager.ts**

After `disconnectUserDiscord` (line 641), before the deprecated `sendFeishuMessage` section (line 643), insert:

```typescript

  async connectUserMQTT(
    userId: string,
    config: MqttConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    options?: {
      ignoreMessagesBefore?: number;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
    },
  ): Promise<boolean> {
    if (!config.brokerUrl || !config.clientId) {
      logger.info({ userId }, 'MQTT config empty, skipping connection');
      return false;
    }

    const channel = createMqttChannel({
      brokerUrl: config.brokerUrl,
      clientId: config.clientId,
      subscribeTopic: config.subscribeTopic || `agents/${config.clientId}/#`,
      username: config.username,
      password: config.password,
    });

    return this.connectChannel(userId, 'mqtt', channel, {
      onReady: () => {
        logger.info({ userId }, 'User MQTT connection established');
      },
      onNewChat,
      ignoreMessagesBefore: options?.ignoreMessagesBefore,
      onCommand: options?.onCommand,
    });
  }

  async disconnectUserMQTT(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'mqtt');
  }
```

After `isDiscordConnected` (line 761), add:

```typescript

  isMQTTConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.channels.get('mqtt')?.isConnected() ?? false;
  }
```

- [ ] **Step 6: Commit**

```bash
git add src/im-channel.ts src/im-manager.ts
git commit -m "功能(mqtt): IMChannel 适配器 + IMConnectionManager 方法"
```

---

### Task 4: Add encrypted config storage

**Files:**
- Modify: `src/runtime-config.ts` (add after Discord config section, before System settings — after line 3458)

- [ ] **Step 1: Add MQTT config types and getter/setter to runtime-config.ts**

After the `saveUserDiscordConfig` function closing brace (line 3458), before the `// ─── System settings` comment (line 3460), insert:

```typescript

// ========== MQTT User IM Config ==========

export interface UserMqttConfig {
  brokerUrl: string;
  clientId: string;
  subscribeTopic: string;
  username?: string;
  password?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

interface StoredMqttConfigV1 {
  version: 1;
  brokerUrl: string;
  clientId: string;
  subscribeTopic: string;
  username?: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface MqttSecretPayload {
  password?: string;
}

export function getUserMqttConfig(userId: string): UserMqttConfig | null {
  const filePath = path.join(userImDir(userId), 'mqtt.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredMqttConfigV1;
    const secret = decryptChannelSecret<MqttSecretPayload>(stored.secret);
    return {
      brokerUrl: (stored.brokerUrl ?? '').trim(),
      clientId: (stored.clientId ?? '').trim(),
      subscribeTopic: (stored.subscribeTopic ?? '').trim(),
      username: stored.username,
      password: secret.password,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user MQTT config');
    return null;
  }
}

export function saveUserMqttConfig(
  userId: string,
  next: Omit<UserMqttConfig, 'updatedAt'>,
): UserMqttConfig {
  const normalized: UserMqttConfig = {
    brokerUrl: (next.brokerUrl ?? '').trim(),
    clientId: (next.clientId ?? '').trim(),
    subscribeTopic: (next.subscribeTopic ?? '').trim(),
    username: next.username?.trim() || undefined,
    password: next.password || undefined,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  // Default subscribe topic if not set
  if (!normalized.subscribeTopic && normalized.clientId) {
    normalized.subscribeTopic = `agents/${normalized.clientId}/#`;
  }

  const payload: StoredMqttConfigV1 = {
    version: 1,
    brokerUrl: normalized.brokerUrl,
    clientId: normalized.clientId,
    subscribeTopic: normalized.subscribeTopic,
    username: normalized.username,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<MqttSecretPayload>({
      password: normalized.password,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'mqtt.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}
```

Note: `encryptChannelSecret`, `decryptChannelSecret`, `userImDir`, and `EncryptedSecrets` are already available in runtime-config.ts scope (they are module-level private helpers used by all other channel configs).

- [ ] **Step 2: Commit**

```bash
git add src/runtime-config.ts
git commit -m "功能(mqtt): 加密配置存储 — getUserMqttConfig / saveUserMqttConfig"
```

---

### Task 5: Add Zod schema and update notify_channels

**Files:**
- Modify: `src/schemas.ts`

- [ ] **Step 1: Add 'mqtt' to notify_channels in TaskPatchSchema**

In `src/schemas.ts` line 20, change:

```typescript
    .array(z.enum(['feishu', 'telegram', 'qq', 'wechat', 'dingtalk', 'discord']))
```

to:

```typescript
    .array(z.enum(['feishu', 'telegram', 'qq', 'wechat', 'dingtalk', 'discord', 'mqtt']))
```

- [ ] **Step 2: Add 'mqtt' to notify_channels in TaskCreateSchema**

In `src/schemas.ts` line 42, change:

```typescript
      .array(z.enum(['feishu', 'telegram', 'qq', 'wechat', 'dingtalk', 'discord']))
```

to:

```typescript
      .array(z.enum(['feishu', 'telegram', 'qq', 'wechat', 'dingtalk', 'discord', 'mqtt']))
```

- [ ] **Step 3: Add MqttConfigSchema**

After the `DiscordConfigSchema` (after line 747), add:

```typescript

export const MqttConfigSchema = z
  .object({
    brokerUrl: z.string().max(2000).optional(),
    clientId: z.string().max(200).optional(),
    subscribeTopic: z.string().max(500).optional(),
    username: z.string().max(200).optional(),
    password: z.string().max(2000).optional(),
    clearPassword: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.brokerUrl === 'string' ||
      typeof data.clientId === 'string' ||
      typeof data.password === 'string' ||
      data.clearPassword === true ||
      typeof data.enabled === 'boolean',
    { message: 'At least one config field must be provided' },
  );
```

- [ ] **Step 4: Commit**

```bash
git add src/schemas.ts
git commit -m "功能(mqtt): Zod schema + notify_channels 枚举扩展"
```

---

### Task 6: Add API routes

**Files:**
- Modify: `src/routes/config.ts`

- [ ] **Step 1: Add imports**

In `src/routes/config.ts`, add `getUserMqttConfig` and `saveUserMqttConfig` to the import from `'../runtime-config.js'` (around line 75-77):

```typescript
  getUserMqttConfig,
  saveUserMqttConfig,
```

Add `MqttConfigSchema` to the import from `'../schemas.js'` (around line 26-27):

```typescript
  MqttConfigSchema,
```

- [ ] **Step 2: Add 'mqtt' to countOtherEnabledImChannels**

In `src/routes/config.ts`, update the `countOtherEnabledImChannels` function signature (line 107) and body. Change:

```typescript
  excludeChannel: 'feishu' | 'telegram' | 'qq' | 'wechat' | 'dingtalk' | 'discord',
```

to:

```typescript
  excludeChannel: 'feishu' | 'telegram' | 'qq' | 'wechat' | 'dingtalk' | 'discord' | 'mqtt',
```

After the discord line (line 119-120), add:

```typescript
  if (excludeChannel !== 'mqtt' && getUserMqttConfig(userId)?.enabled)
    count++;
```

- [ ] **Step 3: Add 'mqtt' to /user-im/status route**

In the `/user-im/status` route response (around line 1303), after the discord line, add:

```typescript
    mqtt: deps?.isUserMQTTConnected?.(user.id) ?? false,
```

- [ ] **Step 4: Add MQTT routes**

After the Discord test route closing (line 2210), before the `// ─── Per-user WeChat IM config` comment (line 2212), insert the three MQTT routes:

```typescript

// ─── Per-user MQTT IM config ────────────────────────────────────

configRoutes.get('/user-im/mqtt', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserMqttConfig(user.id);
    const connected = deps?.isUserMQTTConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        brokerUrl: '',
        clientId: '',
        subscribeTopic: '',
        username: '',
        hasPassword: false,
        enabled: false,
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      brokerUrl: config.brokerUrl,
      clientId: config.clientId,
      subscribeTopic: config.subscribeTopic,
      username: config.username || '',
      hasPassword: !!config.password,
      enabled: config.enabled ?? false,
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user MQTT config');
    return c.json({ error: 'Failed to load MQTT config' }, 500);
  }
});

configRoutes.put('/user-im/mqtt', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = MqttConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const current = getUserMqttConfig(user.id);
    if (!current?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'mqtt'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  // Merge with existing config (password preservation)
  const current = getUserMqttConfig(user.id);
  const next = {
    brokerUrl: current?.brokerUrl || '',
    clientId: current?.clientId || '',
    subscribeTopic: current?.subscribeTopic || '',
    username: current?.username || '',
    password: current?.password || '',
    enabled: current?.enabled ?? true,
  };

  if (typeof validation.data.brokerUrl === 'string') {
    next.brokerUrl = validation.data.brokerUrl.trim();
  }
  if (typeof validation.data.clientId === 'string') {
    next.clientId = validation.data.clientId.trim();
  }
  if (typeof validation.data.subscribeTopic === 'string') {
    next.subscribeTopic = validation.data.subscribeTopic.trim();
  }
  if (typeof validation.data.username === 'string') {
    next.username = validation.data.username.trim();
  }
  if (typeof validation.data.password === 'string') {
    const pw = validation.data.password.trim();
    if (pw) next.password = pw;
  } else if (validation.data.clearPassword === true) {
    next.password = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && (next.brokerUrl || next.clientId)) {
    // First-time config with credentials: auto-enable
    next.enabled = true;
  }

  try {
    const saved = saveUserMqttConfig(user.id, {
      brokerUrl: next.brokerUrl,
      clientId: next.clientId,
      subscribeTopic: next.subscribeTopic,
      username: next.username || undefined,
      password: next.password || undefined,
      enabled: next.enabled,
    });

    // Hot-reload
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'mqtt');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload MQTT connection',
        );
      }
    }

    const connected = deps?.isUserMQTTConnected?.(user.id) ?? false;
    return c.json({
      brokerUrl: saved.brokerUrl,
      clientId: saved.clientId,
      subscribeTopic: saved.subscribeTopic,
      username: saved.username || '',
      hasPassword: !!saved.password,
      enabled: saved.enabled ?? false,
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid MQTT config';
    logger.warn({ err }, 'Invalid MQTT config');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/mqtt/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserMqttConfig(user.id);

  if (!config?.brokerUrl) {
    return c.json({ error: 'MQTT broker URL not configured' }, 400);
  }

  let testClient: ReturnType<typeof import('mqtt').connect> | null = null;
  try {
    const mqttLib = await import('mqtt');
    testClient = mqttLib.connect(config.brokerUrl, {
      clientId:
        'happyclaw-test-' + Math.random().toString(36).slice(2, 8),
      connectTimeout: 10_000,
      username: config.username,
      password: config.password,
    });

    const result = await new Promise<
      { success: true } | { error: string }
    >((resolve) => {
      const timeout = setTimeout(() => {
        testClient?.end(true);
        resolve({ error: 'Connection timeout (10s)' });
      }, 12_000);

      testClient!.on('connect', () => {
        clearTimeout(timeout);
        testClient!.end();
        resolve({ success: true });
      });

      testClient!.on('error', (err: Error) => {
        clearTimeout(timeout);
        testClient!.end(true);
        resolve({ error: err.message });
      });
    });

    if ('success' in result) {
      return c.json(result);
    }
    return c.json(result, 400);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Connection test failed';
    logger.warn({ err }, 'MQTT connection test failed');
    return c.json({ error: message }, 400);
  }
});
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/config.ts
git commit -m "功能(mqtt): API 路由 — GET/PUT/POST test + billing 检查 + 密码保留"
```

---

### Task 7: Wire up index.ts and web-context.ts

**Files:**
- Modify: `src/web-context.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add isUserMQTTConnected to WebDeps**

In `src/web-context.ts`, after the `isUserDiscordConnected` line (line 55), add:

```typescript
  isUserMQTTConnected?: (userId: string) => boolean;
```

Update the `reloadUserIMConfig` type (line 46) to include `'mqtt'`:

```typescript
    channel: 'feishu' | 'telegram' | 'qq' | 'wechat' | 'dingtalk' | 'discord' | 'mqtt',
```

- [ ] **Step 2: Add imports to index.ts**

In `src/index.ts`, add `getUserMqttConfig` to the import from `'./runtime-config.js'` (around line 125-126):

```typescript
  getUserMqttConfig,
```

Add `MqttConnectConfig` to the type import from `'./im-manager.js'` (around line 138):

```typescript
  MqttConnectConfig,
```

- [ ] **Step 3: Add mqtt to connectUserIMChannels signature**

In `src/index.ts`, update the `connectUserIMChannels` function signature. After the `discordConfig` parameter (line 6978), add:

```typescript
  mqttConfig?: MqttConnectConfig | null,
```

Update the return type (around line 6985-6987) to include `mqtt: boolean`.

- [ ] **Step 4: Add mqtt connection block in connectUserIMChannels**

After the `discordTask` block (after line 7106), add:

```typescript

  const mqttTask =
    mqttConfig &&
    mqttConfig.enabled !== false &&
    mqttConfig.brokerUrl &&
    mqttConfig.clientId
      ? imManager.connectUserMQTT(userId, mqttConfig, onNewChat, {
          ignoreMessagesBefore,
          onCommand: handleCommand,
        })
      : Promise.resolve(false);
```

Update the `Promise.all` (line 7108) to include `mqttTask`:

```typescript
  const [feishu, telegram, qq, wechat, dingtalk, discord, mqtt] = await Promise.all([
    feishuTask,
    telegramTask,
    qqTask,
    wechatTask,
    dingtalkTask,
    discordTask,
    mqttTask,
  ]);

  return { feishu, telegram, qq, wechat, dingtalk, discord, mqtt };
```

- [ ] **Step 5: Add mqtt config loading at the callsite of connectUserIMChannels**

Search for where `connectUserIMChannels` is called (in the `loadState` function and user registration). At each callsite, load MQTT config and pass it. The pattern is:

```typescript
const mqttConfig = getUserMqttConfig(userId);
```

Pass it as the new parameter after `discordConfig`.

- [ ] **Step 6: Add mqtt branch to reloadUserIMConfig**

In the `reloadUserIMConfig` function, update the channel type parameter (around line 7523):

```typescript
    channel: 'feishu' | 'telegram' | 'qq' | 'wechat' | 'dingtalk' | 'discord' | 'mqtt',
```

After the discord branch (line 7691), before the `else { // WeChat` branch (line 7692), insert:

```typescript
    } else if (channel === 'mqtt') {
      await imManager.disconnectUserMQTT(userId);
      const config = getUserMqttConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.brokerUrl &&
        config.clientId
      ) {
        const connected = await imManager.connectUserMQTT(
          userId,
          {
            brokerUrl: config.brokerUrl,
            clientId: config.clientId,
            subscribeTopic: config.subscribeTopic,
            username: config.username,
            password: config.password,
            enabled: config.enabled,
          },
          onNewChat,
          {
            ignoreMessagesBefore,
            onCommand: handleCommand,
          },
        );
        logger.info(
          { userId, connected },
          'User MQTT connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User MQTT channel disabled via hot-reload');
      return false;
```

- [ ] **Step 7: Add isUserMQTTConnected to WebDeps object**

In the WebDeps object construction (around line 7762), after `isUserDiscordConnected`, add:

```typescript
    isUserMQTTConnected: (userId: string) =>
      imManager.isMQTTConnected(userId),
```

- [ ] **Step 8: Commit**

```bash
git add src/web-context.ts src/index.ts
git commit -m "功能(mqtt): index.ts 启动加载 + 热重载 + WebDeps 连接状态"
```

---

### Task 8: Add frontend settings card and metadata

**Files:**
- Create: `web/src/components/settings/MQTTChannelCard.tsx`
- Modify: `web/src/components/settings/UserChannelsSection.tsx`
- Modify: `web/src/components/settings/channel-meta.tsx`
- Modify: `web/src/components/settings/BindingsSection.tsx`
- Modify: `web/src/utils/task-utils.ts`

- [ ] **Step 1: Create MQTTChannelCard.tsx**

Create `web/src/components/settings/MQTTChannelCard.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';

interface UserMQTTConfig {
  brokerUrl: string;
  clientId: string;
  subscribeTopic: string;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
}

export function MQTTChannelCard() {
  const [config, setConfig] = useState<UserMQTTConfig | null>(null);
  const [brokerUrl, setBrokerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [subscribeTopic, setSubscribeTopic] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const enabled = config?.enabled ?? false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserMQTTConfig>('/api/config/user-im/mqtt');
      setConfig(data);
      setBrokerUrl(data.brokerUrl || '');
      setClientId(data.clientId || '');
      setSubscribeTopic(data.subscribeTopic || '');
      setUsername(data.username || '');
      setPassword('');
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    try {
      const data = await api.put<UserMQTTConfig>(
        '/api/config/user-im/mqtt',
        { enabled: newEnabled },
      );
      setConfig(data);
      toast.success(`MQTT 渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换 MQTT 渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = brokerUrl.trim();
      const id = clientId.trim();

      if (!url || !id) {
        toast.error('Broker 地址和 Agent 名称不能为空');
        setSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = {
        enabled: true,
        brokerUrl: url,
        clientId: id,
      };
      const topic = subscribeTopic.trim();
      if (topic) payload.subscribeTopic = topic;
      if (username.trim()) payload.username = username.trim();
      if (password.trim()) payload.password = password.trim();

      const data = await api.put<UserMQTTConfig>(
        '/api/config/user-im/mqtt',
        payload,
      );
      setConfig(data);
      setPassword('');
      toast.success('MQTT 配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 MQTT 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await api.post('/api/config/user-im/mqtt/test');
      toast.success('MQTT 连接测试成功');
    } catch (err) {
      toast.error(getErrorMessage(err, 'MQTT 连接测试失败'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-slate-300'}`}
          />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">MQTT</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              通过 MQTT Broker 与其他 Agent 通信
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={loading || toggling}
          onCheckedChange={handleToggle}
        />
      </div>

      <div
        className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Broker 地址
                </label>
                <Input
                  type="text"
                  value={brokerUrl}
                  onChange={(e) => setBrokerUrl(e.target.value)}
                  placeholder="mqtt://192.168.50.75:1883"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Agent 名称（唯一标识）
                </label>
                <Input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="agent-mini-happyclaw"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  订阅 Topic（留空自动生成）
                </label>
                <Input
                  type="text"
                  value={subscribeTopic}
                  onChange={(e) => setSubscribeTopic(e.target.value)}
                  placeholder={`agents/${clientId || '{agent-name}'}/#`}
                />
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">
                    用户名（可选）
                  </label>
                  <Input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="留空则匿名连接"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">
                    密码（可选）
                  </label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      config?.hasPassword ? '留空不修改' : '留空则匿名连接'
                    }
                  />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存 MQTT 配置
              </Button>
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={testing || !brokerUrl.trim()}
              >
                {testing && <Loader2 className="size-4 animate-spin" />}
                测试连接
              </Button>
            </div>

            <div className="text-xs text-slate-400 mt-2">
              <p>
                消息格式：{`{"id":"uuid","from":"agent-name","text":"...","ts":毫秒时间戳}`}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add MQTTChannelCard to UserChannelsSection.tsx**

In `web/src/components/settings/UserChannelsSection.tsx`, add import (after line 6):

```typescript
import { MQTTChannelCard } from './MQTTChannelCard';
```

Add the component after `<DiscordChannelCard />` (after line 19):

```tsx
      <MQTTChannelCard />
```

- [ ] **Step 3: Add MQTT to channel-meta.tsx**

In `web/src/components/settings/channel-meta.tsx`:

Add to `CHANNEL_LABEL` (after line 7):
```typescript
  mqtt: 'MQTT',
```

Add to `CHANNEL_COLORS` (after line 16):
```typescript
  mqtt: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300',
```

Add the MQTT icon component before the `CHANNEL_ICON` record (after DiscordIcon, before line 56):
```tsx
const MqttIcon = () => (
  <svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
  </svg>
);
```

Add to `CHANNEL_ICON` (after line 62):
```typescript
  mqtt: MqttIcon,
```

- [ ] **Step 4: Add 'mqtt' to BindingsSection.tsx ChannelFilter**

In `web/src/components/settings/BindingsSection.tsx` line 13, change:

```typescript
type ChannelFilter = 'all' | 'feishu' | 'telegram' | 'qq' | 'wechat' | 'dingtalk' | 'discord';
```

to:

```typescript
type ChannelFilter = 'all' | 'feishu' | 'telegram' | 'qq' | 'wechat' | 'dingtalk' | 'discord' | 'mqtt';
```

After the discord filter line (line 36), add:

```typescript
    if (types.has('mqtt')) all.push({ key: 'mqtt', label: 'MQTT' });
```

- [ ] **Step 5: Add 'mqtt' to task-utils.ts CHANNEL_OPTIONS**

In `web/src/utils/task-utils.ts`, after the discord entry (line 18), add:

```typescript
  { key: 'mqtt', label: 'MQTT' },
```

- [ ] **Step 6: Commit**

```bash
git add web/src/components/settings/MQTTChannelCard.tsx web/src/components/settings/UserChannelsSection.tsx web/src/components/settings/channel-meta.tsx web/src/components/settings/BindingsSection.tsx web/src/utils/task-utils.ts
git commit -m "功能(mqtt): 前端设置卡片 + 渠道元数据"
```

---

### Task 9: Build verification and type check

**Files:** None (verification only)

- [ ] **Step 1: Run full TypeScript type check**

```bash
make typecheck
```

Expected: No errors related to mqtt. Fix any type errors if they appear.

- [ ] **Step 2: Build backend**

```bash
make build
```

Expected: Clean build with no errors.

- [ ] **Step 3: Start dev server and verify frontend renders**

```bash
make dev
```

Open browser, navigate to Settings page, verify the MQTT card appears in the IM channels section.

- [ ] **Step 4: Test the configuration flow**

1. Toggle MQTT enabled
2. Enter broker URL and client ID
3. Click save
4. Click test connection (with a local MQTT broker if available)

- [ ] **Step 5: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "修复(mqtt): 类型检查和构建修复"
```
