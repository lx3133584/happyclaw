/**
 * Mock IPC filesystem factory for integration tests.
 *
 * Uses a temporary directory to simulate the IPC file-based communication
 * between main process and agent-runner, with automatic cleanup.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

export class MockIpcDir {
  readonly baseDir: string;
  readonly inputDir: string;
  readonly messagesDir: string;
  readonly tasksDir: string;

  constructor(folderName: string = 'test-group') {
    this.baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-mock-'));
    this.inputDir = path.join(this.baseDir, folderName, 'input');
    this.messagesDir = path.join(this.baseDir, folderName, 'messages');
    this.tasksDir = path.join(this.baseDir, folderName, 'tasks');
    fs.mkdirSync(this.inputDir, { recursive: true });
    fs.mkdirSync(this.messagesDir, { recursive: true });
    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  /**
   * Write a message file as if the agent-runner sent it.
   */
  writeAgentMessage(data: Record<string, unknown>): string {
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filepath = path.join(this.messagesDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
    return filename;
  }

  /**
   * Write a task file as if the agent-runner sent it.
   */
  writeAgentTask(data: Record<string, unknown>): string {
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filepath = path.join(this.tasksDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
    return filename;
  }

  /**
   * Write an input file as if the main process injected a message.
   */
  writeInputMessage(text: string, images?: Array<{ data: string; mimeType?: string }>): string {
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filepath = path.join(this.inputDir, filename);
    const data: Record<string, unknown> = { type: 'user_message', text };
    if (images) data.images = images;
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
    return filename;
  }

  /**
   * Read all message files from the messages directory.
   */
  readAllMessages(): Record<string, unknown>[] {
    return this.readJsonDir(this.messagesDir);
  }

  /**
   * Read all task files from the tasks directory.
   */
  readAllTasks(): Record<string, unknown>[] {
    return this.readJsonDir(this.tasksDir);
  }

  /**
   * Read all input files.
   */
  readAllInputs(): Record<string, unknown>[] {
    return this.readJsonDir(this.inputDir);
  }

  /**
   * Clean up the temporary directory.
   */
  cleanup(): void {
    fs.rmSync(this.baseDir, { recursive: true, force: true });
  }

  private readJsonDir(dir: string): Record<string, unknown>[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        return JSON.parse(content) as Record<string, unknown>;
      });
  }
}
