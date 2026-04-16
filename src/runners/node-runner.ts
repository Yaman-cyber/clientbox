import { BaseRunner } from './base.js';
import { NODE_WORKER_SOURCE } from '../workers/node-worker.js';
import type { ClientBoxConfig, RunOptions, RunResult, WorkerResponse } from '../types.js';

export class NodeRunner extends BaseRunner {
  private worker: Worker | null = null;

  constructor(config: ClientBoxConfig) {
    super('node', config);
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const blob = new Blob([NODE_WORKER_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
    }
    return this.worker;
  }

  async run(options: RunOptions): Promise<RunResult> {
    this.assertBrowser();
    this.setStatus('running');
    const start = performance.now();
    const id = this.generateId();
    const timeout = options.timeout ?? this.config.timeout ?? 30_000;

    try {
      const result = await this.withTimeout(
        this.executeInWorker(id, options),
        timeout
      );
      const duration = Math.round(performance.now() - start);
      this.setStatus('ready');
      return { ...result, duration };
    } catch (err) {
      this.terminateWorker();
      const duration = Math.round(performance.now() - start);
      this.setStatus('ready');
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: message,
        error: message,
        exitCode: 1,
        duration,
      };
    }
  }

  private executeInWorker(id: string, options: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const worker = this.ensureWorker();

      const handler = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.id !== id) return;
        worker.removeEventListener('message', handler);
        worker.removeEventListener('error', errorHandler);
        resolve({
          stdout: e.data.stdout,
          stderr: e.data.stderr,
          error: e.data.error,
          exitCode: e.data.exitCode,
          duration: 0,
        });
      };

      const errorHandler = (e: ErrorEvent) => {
        worker.removeEventListener('message', handler);
        worker.removeEventListener('error', errorHandler);
        reject(new Error(e.message || 'Worker error'));
      };

      worker.addEventListener('message', handler);
      worker.addEventListener('error', errorHandler);
      worker.postMessage({
        id,
        type: 'run',
        files: options.files,
        entryPoint: options.entryPoint,
        stdin: options.stdin,
      });
    });
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  destroy(): void {
    this.terminateWorker();
    this.setStatus('destroyed');
  }
}
