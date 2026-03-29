# 钉钉机器人 API 知识

## 消息发送体系

钉钉机器人有两套发送 API，**必须根据场景选对**，否则消息无法送达。

### 1. sessionWebhook（Stream 场景 reply only）

- **来源**：DingTalk Stream SDK 收到消息时，消息体中包含 `sessionWebhook` 字段
- **用途**：仅用于**回复**当前消息（在同一个 Stream 连接内）
- **性质**：是回调 URL，不是主动发送 API
- **失效**：连接断开或 TTL 过期（通常 5 分钟）后不可用
- **结论**：不能用它做主动发消息给用户

### 2. Persistent API（主动发送）

#### C2C 单聊
```
POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend
Headers:
  Content-Type: application/json
  x-acs-dingtalk-access-token: {access_token}
Body:
{
  "robotCode": "{clientId}",          // AppKey/ClientId
  "userIds": ["{senderStaffId}"],     // 企业员工ID（必须）
  "msgKey": "sampleText",             // 或 sampleMarkdown/sampleFile
  "msgParam": "{\"content\":\"内容\"}"  // 注意：key 是 content 不是 text！
}
```

#### 群聊
```
POST https://api.dingtalk.com/v1.0/robot/groupMessages/send
Headers: 同上
Body:
{
  "robotCode": "{clientId}",
  "openConversationId": "{群openConversationId}",
  "msgKey": "sampleText",
  "msgParam": "{\"content\":\"内容\"}"
}
```

### 常见 msgKey 及 msgParam 结构

**⚠️ 关键纠正（2026-03-26）：**
- `sampleText` 的 msgParam key 是 `content`，不是 `text`！
- 用错 key 会导致用户收到字面 "#content#"

| msgKey | msgParam 结构 |
|--------|--------------|
| `sampleText` | `{"content": "内容"}` |
| `sampleMarkdown` | `{"title": "标题", "text": "内容"}` |
| `sampleFile` | `{"mediaId": "xxx", "fileName": "文件名"}` |
| `sampleImage` | `{"mediaId": "xxx"}` |
| `sampleAudio` | `{"mediaId": "xxx"}` |

## 媒体文件上传

### 旧版 API（目前 HappyClaw 在用）
```
POST https://oapi.dingtalk.com/media/upload?access_token={token}&type={type}
Content-Type: multipart/form-data
```

**Body 字段**：
- `type`: `image` | `file` | `voice` | `video`
- `media`: 文件二进制内容，filename 字段必填

**响应**：
```json
{
  "errcode": 0,
  "errmsg": "ok",
  "media_id": "@lAVsxxxxx"  // 可能带前缀 @，需要 strip
}
```

**注意**：
- 图片限制 10MB，文件 20MB，音频 2MB，视频 20MB
- `media_id` 前缀 `@` 需要去掉再使用
- `Content-Type` 应设为文件的真实 MIME type，不只是 `application/octet-stream`

### 新版 API
待补充（dingtalk-openclaw-connector 用的是旧版 oapi）

## 关键字段说明

| 字段 | 说明 | 用途 |
|------|------|------|
| `senderId` | 发送者个人 ID（用户级别，不唯一） | 主要用于 jid 构造 |
| `senderStaffId` | 企业员工 ID（唯一，**persistent API 必需**） | C2C batchSend userIds |
| `conversationId` | C2C 会话 ID | 群聊场景 |
| `openConversationId` | 群会话 ID | 群聊 persistent API |
| `sessionWebhook` | 回调 URL | Stream SDK reply only |
| `media_id` | 上传后媒体文件 ID | 消息体内嵌 |

## JID 格式约定

```
C2C:  dingtalk:c2c:{senderId}
群组: dingtalk:group:{conversationId}
```

## HappyClaw 关键实现点

### 消息接收存储（handleRobotMessage）
- `lastSessionWebhooks.set(jid, sessionWebhook)` — key 是完整 jid
- `lastSenderIds.set(jid, senderId)` — key 是完整 jid
- `lastSenderStaffIds.set(jid, senderStaffId)` — key 是完整 jid

### 消息发送路由（sendMessage）
- **C2C**：用 `senderStaffId` + persistent API (`/v1.0/robot/oToMessages/batchSend`)
- **群组**：用 `sessionWebhook`（reply 场景，仍有效）

### sendFile 查找（Bug 修复）
`sendFile` 收到的是 bare chatId（`extractChatId` 去掉前缀的结果），但 `lastSenderIds`/`lastSenderStaffIds` 的 key 是完整 jid，所以查找前必须拼接回完整 jid：
```typescript
const jidKey = `dingtalk:c2c:${chatId}`; // 或 dingtalk:group:${chatId}
const senderStaffId = lastSenderStaffIds.get(jidKey);
```

### 错误排查
- API 返回 200 但用户没收到消息 → 极可能用了 sessionWebhook 做主动发送（应用 persistent API）
- `senderStaffId` 为空 → 确认是企业内部机器人，外部用户没有 staffId
- media_id 发送失败 → 确认已 strip `@` 前缀
- **用户收到 "#content#" 或 "#text#"** → msgParam 的 JSON key 写错了！
  - `sampleText` 应为 `{"content": "内容"}`，不是 `{"text": "内容"}`
  - 调试：看日志中 `sendViaPersistentAPI` 的 `msgParam` 字段
