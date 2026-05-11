import { BaseRunner } from './base.js';
import { NODE_WORKER_SOURCE } from '../workers/node-worker.js';
import type { ClientBoxConfig, RunOptions, RunResult, WorkerResponse } from '../types.js';

const CTRL_INTS = 2;
const CTRL_BYTES = CTRL_INTS * 4;
const INPUT_BUFFER_BYTES = 64 * 1024;

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
    const wantsInteractiveInput = typeof options.onInput === 'function';
    let sab: SharedArrayBuffer | null = null;
    let ctrl: Int32Array | null = null;
    let dataView: Uint8Array | null = null;

    if (wantsInteractiveInput) {
      const SAB = (globalThis as { SharedArrayBuffer?: SharedArrayBufferConstructor }).SharedArrayBuffer;
      const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
      if (!SAB || isolated === false) {
        return Promise.reject(
          new Error(
            'Interactive Node input requires SharedArrayBuffer. ' +
              'Serve the host page with COOP/COEP headers ' +
              '(Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp) ' +
              'so window.crossOriginIsolated is true.'
          )
        );
      }
      sab = new SAB(CTRL_BYTES + INPUT_BUFFER_BYTES);
      ctrl = new Int32Array(sab, 0, CTRL_INTS);
      dataView = new Uint8Array(sab, CTRL_BYTES);
    }

    return new Promise((resolve, reject) => {
      const worker = this.ensureWorker();
      let pendingStdout = '';

      const handleInputRequest = async () => {
        if (!ctrl || !dataView || !options.onInput) return;
        try {
          const prompt = pendingStdout;
          pendingStdout = '';
          const result = await options.onInput(prompt);
          if (result === null || result === undefined) {
            Atomics.store(ctrl, 1, 0);
            Atomics.store(ctrl, 0, 2);
          } else {
            const bytes = new TextEncoder().encode(String(result));
            const len = Math.min(bytes.length, dataView.byteLength);
            dataView.set(bytes.subarray(0, len), 0);
            Atomics.store(ctrl, 1, len);
            Atomics.store(ctrl, 0, 1);
          }
        } catch {
          Atomics.store(ctrl, 1, 0);
          Atomics.store(ctrl, 0, 2);
        }
        Atomics.notify(ctrl, 0);
      };

      const handler = (e: MessageEvent) => {
        const data = e.data;
        if (data.id !== id) return;
        if (data.type === 'stdout') {
          pendingStdout += data.chunk;
          options.onStdout?.(data.chunk);
          return;
        }
        if (data.type === 'stderr') {
          options.onStderr?.(data.chunk);
          return;
        }
        if (data.type === 'input-request') {
          void handleInputRequest();
          return;
        }
        if (data.type === 'result' || data.type === 'error') {
          const response = data as WorkerResponse;
          worker.removeEventListener('message', handler);
          worker.removeEventListener('error', errorHandler);
          resolve({
            stdout: response.stdout,
            stderr: response.stderr,
            error: response.error,
            exitCode: response.exitCode,
            duration: 0,
          });
        }
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
        sab,
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
