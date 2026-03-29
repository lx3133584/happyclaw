/**
 * Story A9: IM slash command formatting
 *
 * Tests the pure functions in im-command-utils.ts that power
 * /list, /status, /recall, /clear commands across all IM channels.
 */
import { describe, it, expect } from 'vitest';
import {
  formatContextMessages,
  formatWorkspaceList,
  resolveLocationInfo,
  formatSystemStatus,
} from '../../src/im-command-utils';
import type {
  MessageForContext,
  WorkspaceInfo,
  RegisteredGroupLike,
} from '../../src/im-command-utils';

// ─── formatContextMessages ───

describe('formatContextMessages', () => {
  it('returns empty string for empty array', () => {
    expect(formatContextMessages([])).toBe('');
  });

  it('formats user messages with user icon', () => {
    const msgs: MessageForContext[] = [
      { sender: 'user1', sender_name: 'Alice', content: 'Hello', is_from_me: false },
    ];
    const result = formatContextMessages(msgs);
    expect(result).toContain('👤Alice');
    expect(result).toContain('Hello');
  });

  it('formats bot messages with robot icon', () => {
    const msgs: MessageForContext[] = [
      { sender: 'bot', sender_name: 'Bot', content: 'Hi there', is_from_me: true },
    ];
    const result = formatContextMessages(msgs);
    expect(result).toContain('🤖');
    expect(result).toContain('Hi there');
  });

  it('skips __system__ messages', () => {
    const msgs: MessageForContext[] = [
      { sender: '__system__', sender_name: 'System', content: 'hidden', is_from_me: false },
      { sender: 'user1', sender_name: 'Bob', content: 'visible', is_from_me: false },
    ];
    const result = formatContextMessages(msgs);
    expect(result).not.toContain('hidden');
    expect(result).toContain('visible');
  });

  it('truncates long messages', () => {
    const longContent = 'x'.repeat(200);
    const msgs: MessageForContext[] = [
      { sender: 'user1', sender_name: 'Test', content: longContent, is_from_me: false },
    ];
    const result = formatContextMessages(msgs, 80);
    // Should be truncated to 80 + '…'
    expect(result).toContain('…');
    expect(result.length).toBeLessThan(longContent.length + 50);
  });

  it('replaces newlines in content with spaces', () => {
    const msgs: MessageForContext[] = [
      { sender: 'u1', sender_name: 'A', content: 'line1\nline2', is_from_me: false },
    ];
    const result = formatContextMessages(msgs);
    expect(result).toContain('line1 line2');
    expect(result).not.toMatch(/line1\nline2/);
  });
});

// ─── formatWorkspaceList ───

describe('formatWorkspaceList', () => {
  const workspaces: WorkspaceInfo[] = [
    {
      folder: 'main',
      name: 'Main Workspace',
      agents: [
        { id: 'agent-abc-123', name: 'Code Reviewer', status: 'running' },
      ],
    },
    {
      folder: 'project-x',
      name: 'Project X',
      agents: [],
    },
  ];

  it('shows "no workspaces" when empty', () => {
    expect(formatWorkspaceList([], 'main', null)).toContain(
      '没有可用的工作区',
    );
  });

  it('marks current workspace with arrow', () => {
    const result = formatWorkspaceList(workspaces, 'main', null);
    expect(result).toContain('▶');
    expect(result).toContain('Main Workspace');
  });

  it('marks current agent with arrow', () => {
    const result = formatWorkspaceList(workspaces, 'main', 'agent-abc-123');
    expect(result).toContain('← 当前');
  });

  it('shows agent short ID (first 4 chars)', () => {
    const result = formatWorkspaceList(workspaces, 'main', null);
    expect(result).toContain('[agen]');
    // Actually the ID is 'agent-abc-123', first 4 chars = 'agen'
  });

  it('shows running status icon for active agents', () => {
    const result = formatWorkspaceList(workspaces, 'main', null);
    expect(result).toContain('🔄');
  });

  it('shows workspace folder in parentheses', () => {
    const result = formatWorkspaceList(workspaces, 'main', null);
    expect(result).toContain('(main)');
    expect(result).toContain('(project-x)');
  });
});

// ─── resolveLocationInfo ───

describe('resolveLocationInfo', () => {
  const mockGetGroup = (jid: string): RegisteredGroupLike | undefined => {
    const groups: Record<string, RegisteredGroupLike> = {
      'feishu:oc_main': {
        folder: 'main',
        name: 'Main',
        target_agent_id: undefined,
        target_main_jid: undefined,
      },
      'feishu:oc_routed': {
        folder: 'project-x',
        name: 'Routed Group',
        target_main_jid: 'feishu:oc_main',
        reply_policy: 'source_only',
      },
    };
    return groups[jid];
  };

  const mockGetAgent = (id: string) => {
    if (id === 'agent-123')
      return { name: 'Reviewer', chat_jid: 'feishu:oc_main' };
    return undefined;
  };

  const mockFindName = (folder: string) =>
    folder === 'main' ? 'Main Workspace' : folder;

  it('resolves direct group (no routing)', () => {
    const group: RegisteredGroupLike = {
      folder: 'main',
      name: 'Direct',
    };
    const result = resolveLocationInfo(group, mockGetGroup, mockGetAgent, mockFindName);
    expect(result.locationLine).toBe('Main Workspace / 主对话');
    expect(result.folder).toBe('main');
    expect(result.replyPolicy).toBeNull();
  });

  it('resolves agent-routed group', () => {
    const group: RegisteredGroupLike = {
      folder: 'main',
      name: 'Agent Group',
      target_agent_id: 'agent-123',
    };
    const result = resolveLocationInfo(group, mockGetGroup, mockGetAgent, mockFindName);
    expect(result.locationLine).toContain('Reviewer');
    expect(result.replyPolicy).toBe('source_only');
  });

  it('resolves main-jid-routed group', () => {
    const group: RegisteredGroupLike = {
      folder: 'project-x',
      name: 'Routed',
      target_main_jid: 'feishu:oc_main',
      reply_policy: 'source_only',
    };
    const result = resolveLocationInfo(group, mockGetGroup, mockGetAgent, mockFindName);
    expect(result.locationLine).toContain('Main');
    expect(result.replyPolicy).toBe('source_only');
  });
});

// ─── formatSystemStatus ───

describe('formatSystemStatus', () => {
  it('shows "运行中" when active', () => {
    const result = formatSystemStatus(
      { locationLine: 'Main / 主对话', folder: 'main', replyPolicy: null },
      {
        activeContainerCount: 2,
        activeHostProcessCount: 1,
        maxContainers: 20,
        maxHostProcesses: 5,
        waitingCount: 0,
        waitingGroupJids: [],
      },
      true, // isActive
      null,
    );
    expect(result).toContain('运行中');
    expect(result).toContain('2/20 容器');
    expect(result).toContain('1/5 进程');
  });

  it('shows "排队中" when queued', () => {
    const result = formatSystemStatus(
      { locationLine: 'Test', folder: 'test', replyPolicy: null },
      {
        activeContainerCount: 20,
        activeHostProcessCount: 5,
        maxContainers: 20,
        maxHostProcesses: 5,
        waitingCount: 3,
        waitingGroupJids: ['jid1', 'jid2', 'jid3'],
      },
      false,
      2, // queuePosition
    );
    expect(result).toContain('排队中 (#2)');
  });

  it('shows "空闲" when not active and not queued', () => {
    const result = formatSystemStatus(
      { locationLine: 'Test', folder: 'test', replyPolicy: null },
      {
        activeContainerCount: 0,
        activeHostProcessCount: 0,
        maxContainers: 20,
        maxHostProcesses: 5,
        waitingCount: 0,
        waitingGroupJids: [],
      },
      false,
      null,
    );
    expect(result).toContain('空闲');
  });
});
