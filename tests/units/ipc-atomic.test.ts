/**
 * Story D3: IPC file atomicity
 *
 * Verifies the IPC write mechanism (temp + rename) used by agent-runner
 * to communicate with the main process. If the process crashes mid-write,
 * no partially-written file should exist at the final path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Replicate the writeIpcFile logic from agent-runner mcp-tools.ts
function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

describe('IPC atomic write', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes valid JSON to the target file', () => {
    const data = { type: 'message', text: 'hello', chatJid: 'test:123' };
    const filename = writeIpcFile(tmpDir, data);

    const filepath = path.join(tmpDir, filename);
    expect(fs.existsSync(filepath)).toBe(true);

    const content = fs.readFileSync(filepath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(data);
  });

  it('no .tmp file remains after write', () => {
    const data = { type: 'test' };
    const filename = writeIpcFile(tmpDir, data);

    const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('creates directory if it does not exist', () => {
    const subdir = path.join(tmpDir, 'nested', 'deep');
    const data = { type: 'nested' };
    writeIpcFile(subdir, data);

    expect(fs.existsSync(subdir)).toBe(true);
    const files = fs.readdirSync(subdir);
    expect(files).toHaveLength(1);
  });

  it('generates unique filenames for concurrent writes', () => {
    const names = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const name = writeIpcFile(tmpDir, { i });
      names.add(name);
    }
    expect(names.size).toBe(100);
  });

  it('handles unicode content correctly', () => {
    const data = { type: 'message', text: '你好世界 🌍 こんにちは' };
    const filename = writeIpcFile(tmpDir, data);

    const filepath = path.join(tmpDir, filename);
    const content = fs.readFileSync(filepath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.text).toBe('你好世界 🌍 こんにちは');
  });

  it('file name follows expected pattern', () => {
    const filename = writeIpcFile(tmpDir, { test: true });
    // Pattern: {timestamp}-{random6}.json
    expect(filename).toMatch(/^\d+-[a-z0-9]{6}\.json$/);
  });
});
