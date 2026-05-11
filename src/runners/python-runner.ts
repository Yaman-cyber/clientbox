import { BaseRunner } from './base.js';
import { PYTHON_WORKER_SOURCE } from '../workers/python-worker.js';
import type { ClientBoxConfig, RunOptions, RunResult, WorkerResponse } from '../types.js';

const DEFAULT_PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';

// Shared-buffer layout — must match the worker.
const CTRL_INTS = 2;
const CTRL_BYTES = CTRL_INTS * 4;
const INPUT_BUFFER_BYTES = 64 * 1024;

export class PythonRunner extends BaseRunner {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: ClientBoxConfig) {
    super('python', config);
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker && this.initPromise) {
      await this.initPromise;
      return this.worker!;
    }

    this.setStatus('loading', 'Downloading Pyodide runtime...');

    const blob = new Blob([PYTHON_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    this.worker = new Worker(url);
    URL.revokeObjectURL(url);

    const worker = this.worker;

    this.initPromise = new Promise<void>((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'ready') {
          worker.removeEventListener('message', handler);
          this.setStatus('ready', 'Pyodide loaded');
          resolve();
        } else if (e.data.type === 'init-error') {
          worker.removeEventListener('message', handler);
          reject(new Error(e.data.error));
        }
      };
      worker.addEventListener('message', handler);
    });

    this.worker.postMessage({
      type: 'init',
      pyodideCdnUrl: this.config.pyodideCdnUrl || DEFAULT_PYODIDE_CDN,
    });

    await this.initPromise;
    return this.worker;
  }

  async run(options: RunOptions): Promise<RunResult> {
    this.assertBrowser();
    const start = performance.now();
    const timeout = options.timeout ?? this.config.timeout ?? 30_000;
    const id = this.generateId();

    try {
      const result = await this.withTimeout(
        (async () => {
          const worker = await this.ensureWorker();
          this.setStatus('running');
          return this.executeInWorker(worker, id, options);
        })(),
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

  private executeInWorker(
    worker: Worker,
    id: string,
    options: RunOptions
  ): Promise<RunResult> {
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
            'Interactive Python input requires SharedArrayBuffer. ' +
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
      const handleInputRequest = async () => {
        if (!ctrl || !dataView || !options.onInput) return;
        try {
          // Latest stdout so far is the prompt; we hand it to the caller.
          const prompt = pendingStdout;
          pendingStdout = '';
          const result = await options.onInput(prompt);
          if (result === null || result === undefined) {
            Atomics.store(ctrl, 1, 0);
            Atomics.store(ctrl, 0, 2); // EOF
          } else {
            const bytes = new TextEncoder().encode(String(result));
            const len = Math.min(bytes.length, dataView.byteLength);
            dataView.set(bytes.subarray(0, len), 0);
            Atomics.store(ctrl, 1, len);
            Atomics.store(ctrl, 0, 1); // ready
          }
        } catch {
          Atomics.store(ctrl, 1, 0);
          Atomics.store(ctrl, 0, 2);
        }
        Atomics.notify(ctrl, 0);
      };

      let pendingStdout = '';

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
          worker.removeEventListener('error', errHandler);
          resolve({
            stdout: response.stdout,
            stderr: response.stderr,
            error: response.error,
            exitCode: response.exitCode,
            duration: 0,
          });
        }
      };

      const errHandler = (e: ErrorEvent) => {
        worker.removeEventListener('message', handler);
        worker.removeEventListener('error', errHandler);
        reject(new Error(e.message || 'Worker error'));
      };

      worker.addEventListener('message', handler);
      worker.addEventListener('error', errHandler);
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
      this.initPromise = null;
    }
  }

  destroy(): void {
    this.terminateWorker();
    this.setStatus('destroyed');
  }
}
