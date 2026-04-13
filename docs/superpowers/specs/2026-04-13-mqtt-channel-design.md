# MQTT IM Channel Design

## Overview

Add MQTT as a new IM channel, enabling HappyClaw agents to communicate with external agents/services through an MQTT broker. Follows the same connection factory + IMChannel adapter + IMConnectionManager pattern used by all existing channels (Feishu, Telegram, QQ, DingTalk, Discord, WeChat).

## Motivation

MQTT is a lightweight pub/sub protocol widely used in IoT and inter-service communication. Adding it as an IM channel allows HappyClaw agents to:

- Receive commands from external automation systems
- Communicate with other AI agent instances
- Integrate with IoT devices and monitoring systems

## Message Protocol

### Topic Convention

```
agents/{agent-name}/inbox    — direct message to a specific agent
agents/broadcast             — broadcast to all agents
```

### Payload Format (JSON)

```json
{
  "id": "uuid-v4",
  "from": "agent-mini",
  "text": "hello",
  "ts": 1744201234567
}
```

| Field  | Required | Description                              |
|--------|----------|------------------------------------------|
| `id`   | Yes      | Sender-generated UUID for deduplication  |
| `from` | Yes      | Sender agent name (used to construct JID)|
| `text` | Yes      | Message content (plain text or Markdown) |
| `ts`   | No       | Unix timestamp in milliseconds           |

**Plain text fallback**: If payload is not valid JSON, treat the raw string as `text` and extract sender from topic path (`agents/{sender}/...`).

### JID Format

`mqtt:{from}` — e.g., `mqtt:agent-mini-happyclaw`

This naturally integrates with the existing `extractChatId()` / `getChannelType()` routing.

## Architecture

### Layer 1: Connection Factory (`src/mqtt.ts`)

Exports:

```typescript
export interface MqttConnectionConfig {
  brokerUrl: string;        // e.g. "mqtt://192.168.50.75:1883"
  clientId: string;         // unique agent name
  subscribeTopic: string;   // e.g. "agents/my-agent/#"
  username?: string;
  password?: string;
}

export interface MqttConnection {
  connect(opts: MqttConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  isConnected(): boolean;
}

export function createMqttConnection(config: MqttConnectionConfig): MqttConnection;
```

Key behaviors:

- **Self-echo filtering**: Messages where `from === config.clientId` are silently dropped. This prevents infinite loops when subscribing to broadcast topics or wildcards.
- **Deduplication**: Uses `id` field from payload as dedup key (LRU cache, 1000 entries, 30min TTL). Falls back to `from:ts:text[:50]` for plain-text messages without `id`.
- **Stale message filtering**: Respects `ignoreMessagesBefore` timestamp (same as other channels).
- **Auto-reconnect**: `mqtt` library handles reconnection natively (`reconnectPeriod: 5000`).
- **Broadcast subscription**: Always subscribes to `agents/broadcast` in addition to the configured `subscribeTopic`.
- **QoS 0** for all publish/subscribe (at-most-once delivery). Sufficient for chat messages.

### Layer 2: IMChannel Adapter (`src/im-channel.ts`)

```typescript
export function createMqttChannel(config: MqttConnectionConfig): IMChannel;
```

Wraps `MqttConnection` into the `IMChannel` interface:

- `sendMessage(chatId, text)` → publishes to `agents/{chatId}/inbox`
- `setTyping()` → no-op (MQTT has no typing indicators)
- `sendFile()` / `sendImage()` → not implemented (optional in IMChannel)
- `createStreamingSession()` → not implemented (MQTT can't edit messages)

### Layer 3: IMConnectionManager (`src/im-manager.ts`)

New methods:

```typescript
async connectUserMQTT(userId, config, onNewChat, options?): Promise<boolean>
async disconnectUserMQTT(userId): Promise<void>
isMQTTConnected(userId): boolean
```

Follows the exact same pattern as `connectUserDingTalk()`.

### Layer 4: Config Storage (`src/runtime-config.ts`)

Encrypted storage using AES-256-GCM, matching the DingTalk pattern:

```typescript
interface StoredMqttConfigV1 {
  version: 1;
  brokerUrl: string;          // plain
  clientId: string;           // plain
  subscribeTopic: string;     // plain
  username?: string;          // plain
  enabled?: boolean;          // plain
  updatedAt: string;          // plain
  secret: EncryptedSecrets;   // encrypted container
}

interface MqttSecretPayload {
  password?: string;          // encrypted
}
```

`brokerUrl` is stored in plaintext because:
- It's not a credential (it's an address)
- The GET endpoint needs to return it unmasked to the frontend
- `password` IS encrypted, consistent with how other channels handle secrets

Functions: `getUserMqttConfig(userId)` / `saveUserMqttConfig(userId, next)`

### Layer 5: API Routes (`src/routes/config.ts`)

Three endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/config/user-im/mqtt` | Return config + connected status |
| PUT    | `/api/config/user-im/mqtt` | Update config (merge semantics) |
| POST   | `/api/config/user-im/mqtt/test` | Test broker connectivity |

**PUT merge semantics** (critical): Read existing config first, only overwrite fields that are explicitly provided. This prevents toggle-only requests (`{ enabled: false }`) from clearing credentials.

**Password preservation**: Empty string in `password` field is ignored; use `clearPassword: true` to explicitly clear.

**Billing check**: When enabling, call `checkImChannelLimit()` (same as all other channels).

**Zod schema**:

```typescript
export const MqttConfigSchema = z.object({
  brokerUrl: z.string().max(2000).optional(),
  clientId: z.string().max(200).optional(),
  subscribeTopic: z.string().max(500).optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(2000).optional(),
  clearPassword: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).refine(
  (d) => typeof d.brokerUrl === 'string' || typeof d.clientId === 'string' ||
         typeof d.password === 'string' || d.clearPassword === true ||
         typeof d.enabled === 'boolean',
  { message: 'At least one config field must be provided' },
);
```

### Layer 6: Index Integration (`src/index.ts`)

- `connectUserIMChannels()`: Add mqtt config loading + connection (parallel with others)
- `reloadUserIMConfig()`: Add `'mqtt'` branch (disconnect → reconnect)
- WebDeps: Expose `isUserMQTTConnected`

### Layer 7: Frontend (`web/src/components/settings/MQTTChannelCard.tsx`)

Settings card with:
- Enable/disable toggle
- Broker URL input
- Agent name (clientId) input
- Subscribe topic input (auto-generated default: `agents/{clientId}/#`)
- Optional username/password
- Connection test button
- Connection status indicator

Follows `DingTalkChannelCard.tsx` structure.

## File Changes

| File | Change |
|------|--------|
| `package.json` | Add `mqtt` dependency |
| **new** `src/mqtt.ts` | Connection factory |
| `src/im-channel.ts` | Add `createMqttChannel()` adapter |
| `src/im-manager.ts` | Add `connectUserMQTT` / `disconnectUserMQTT` / `isMQTTConnected` |
| `src/runtime-config.ts` | Add encrypted config getter/setter |
| `src/schemas.ts` | Add `MqttConfigSchema` + `'mqtt'` to `notify_channels` |
| `src/routes/config.ts` | Add 3 API routes + billing check |
| `src/index.ts` | Startup loading + hot-reload |
| `src/web-context.ts` | Add `isUserMQTTConnected` to `WebDeps` |
| `shared/channel-prefixes.ts` | Add `mqtt: 'mqtt:'` |
| `src/channel-prefixes.ts` | Sync copy |
| `container/agent-runner/src/channel-prefixes.ts` | Sync copy |
| **new** `web/src/components/settings/MQTTChannelCard.tsx` | Frontend config card |
| `web/src/components/settings/UserChannelsSection.tsx` | Import + render card |
| `web/src/components/settings/channel-meta.tsx` | Label/color/icon |
| `web/src/components/settings/BindingsSection.tsx` | Channel filter type |
| `web/src/utils/task-utils.ts` | Notification channel option |

## Not In Scope

- **File/image transfer**: MQTT payloads are JSON text; binary transfer out of scope
- **Streaming sessions**: MQTT can't edit published messages
- **@mention control**: No group chat concept in MQTT
- **Pairing codes**: Not needed; auto-register by `from` field
- **QoS configuration**: Fixed at QoS 0; configurable QoS is a future enhancement
