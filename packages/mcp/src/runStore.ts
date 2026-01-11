import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type RunStatus = "running" | "finished" | "killed";

export type RunRecord = {
  runId: string;
  repo: string;
  cmd: string;
  argv: string[];
  cwd: string;
  status: RunStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  logPath: string;
  bytesWritten: number;
};

type LogChunk = {
  offset: number;
  nextOffset: number;
  stream: "stdout" | "stderr" | "mixed";
  data: string;
};

type Subscriber = (chunk: LogChunk) => void;

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly buffers = new Map<string, LogChunk[]>();
  private readonly bufferSizes = new Map<string, number>();
  private readonly bufferLimit: number;
  private readonly runsDir: string;

  constructor(repoRoot: string, opts?: { bufferLimit?: number }) {
    this.bufferLimit = opts?.bufferLimit ?? 1024 * 1024;
    this.runsDir = path.join(repoRoot, ".lanai", "runs");
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  createRun(info: { repo: string; cmd: string; argv: string[]; cwd: string }): RunRecord {
    const runId = randomUUID();
    const logPath = path.join(this.runsDir, `${runId}.log`);
    const record: RunRecord = {
      runId,
      repo: info.repo,
      cmd: info.cmd,
      argv: info.argv,
      cwd: info.cwd,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      logPath,
      bytesWritten: 0
    };

    this.runs.set(runId, record);
    this.saveMeta(record);

    return record;
  }

  append(runId: string, stream: "stdout" | "stderr", data: string): void {
    const record = this.runs.get(runId);
    if (!record) return;

    const bytes = Buffer.byteLength(data);
    const offset = record.bytesWritten;
    const nextOffset = offset + bytes;

    record.bytesWritten = nextOffset;

    try {
      fs.appendFileSync(record.logPath, data);
    } catch {
      // Ignore file write errors to avoid breaking command execution.
    }

    const entry: LogChunk = { offset, nextOffset, stream, data };
    const list = this.buffers.get(runId) ?? [];
    list.push(entry);

    let size = (this.bufferSizes.get(runId) ?? 0) + bytes;
    while (size > this.bufferLimit && list.length) {
      const removed = list.shift();
      if (removed) {
        size -= Buffer.byteLength(removed.data);
      }
    }

    this.buffers.set(runId, list);
    this.bufferSizes.set(runId, size);

    const subs = this.subscribers.get(runId);
    if (subs) {
      for (const sub of subs) {
        sub(entry);
      }
    }
  }

  finish(runId: string, exitCode: number | null, status: RunStatus): void {
    const record = this.runs.get(runId);
    if (!record) return;

    record.status = status;
    record.exitCode = exitCode;
    record.endedAt = new Date().toISOString();
    this.saveMeta(record);
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  getLogPath(runId: string): string {
    return this.runs.get(runId)?.logPath ?? path.join(this.runsDir, `${runId}.log`);
  }

  subscribe(runId: string, handler: Subscriber): () => void {
    const set = this.subscribers.get(runId) ?? new Set();
    set.add(handler);
    this.subscribers.set(runId, set);

    return () => {
      set.delete(handler);
      if (!set.size) {
        this.subscribers.delete(runId);
      }
    };
  }

  private saveMeta(record: RunRecord): void {
    const metaPath = path.join(this.runsDir, `${record.runId}.json`);
    try {
      fs.writeFileSync(metaPath, JSON.stringify(record, null, 2));
    } catch {
      // Ignore metadata write errors.
    }
  }
}
