import type {
  ClientBoxConfig,
  Language,
  RunOptions,
  RunResult,
  RunnerStatus,
} from '../types.js';

export abstract class BaseRunner {
  protected config: ClientBoxConfig;
  protected language: Language;
  protected status: RunnerStatus = 'idle';

  constructor(language: Language, config: ClientBoxConfig) {
    this.language = language;
    this.config = config;
  }

  protected assertBrowser(): void {
    if (typeof window === 'undefined' && typeof self === 'undefined') {
      throw new Error(
        `[clientbox] The "${this.language}" runner requires a browser environment. ` +
          'If you are using SSR (Next.js, Nuxt, etc.), make sure to only call run() from client-side code.'
      );
    }
  }

  protected setStatus(status: RunnerStatus, message?: string): void {
    this.status = status;
    this.config.onStatusChange?.({
      language: this.language,
      status,
      message,
    });
  }

  protected generateId(): string {
    return `${this.language}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  protected withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[clientbox] Execution timed out after ${ms}ms`)),
        ms
      );
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  abstract run(options: RunOptions): Promise<RunResult>;

  abstract destroy(): void;
}
