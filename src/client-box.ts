import type {
  ClientBoxConfig,
  Language,
  RunOptions,
  RunResult,
} from './types.js';
import { BaseRunner } from './runners/base.js';
import { NodeRunner } from './runners/node-runner.js';
import { PythonRunner } from './runners/python-runner.js';
import { WebRunner } from './runners/web-runner.js';
import { CSharpRunner } from './runners/csharp-runner.js';
import { JavaRunner } from './runners/java-runner.js';
import { PhpRunner } from './runners/php-runner.js';
import { DartRunner } from './runners/dart-runner.js';
import { GoRunner } from './runners/go-runner.js';

const RUNNER_MAP: Record<Language, new (config: ClientBoxConfig) => BaseRunner> = {
  node: NodeRunner,
  python: PythonRunner,
  web: WebRunner,
  csharp: CSharpRunner,
  java: JavaRunner,
  php: PhpRunner,
  dart: DartRunner,
  go: GoRunner,
};

export class ClientBox {
  private config: ClientBoxConfig;
  private runners = new Map<Language, BaseRunner>();
  private destroyed = false;

  constructor(config: ClientBoxConfig = {}) {
    this.config = {
      timeout: 30_000,
      ...config,
    };
  }

  private getRunner(language: Language): BaseRunner {
    if (this.destroyed) {
      throw new Error('[clientbox] This instance has been destroyed. Create a new ClientBox().');
    }

    let runner = this.runners.get(language);
    if (!runner) {
      const RunnerClass = RUNNER_MAP[language];
      if (!RunnerClass) {
        throw new Error(
          `[clientbox] Unsupported language: "${language}". ` +
            `Supported: ${Object.keys(RUNNER_MAP).join(', ')}`
        );
      }
      runner = new RunnerClass(this.config);
      this.runners.set(language, runner);
    }
    return runner;
  }

  /**
   * Execute code in the specified language.
   *
   * @param language - The target language ('node' | 'python' | 'web' | 'csharp' | 'java' | 'php' | 'dart')
   * @param options  - Files, entry point, and execution options
   * @returns The execution result with stdout, stderr, error info, and timing
   */
  async run(language: Language, options: RunOptions): Promise<RunResult> {
    const runner = this.getRunner(language);
    return runner.run(options);
  }

  /**
   * Clean up all runners, terminating workers and removing iframes.
   * The instance cannot be reused after calling destroy().
   */
  destroy(): void {
    this.destroyed = true;
    for (const runner of this.runners.values()) {
      runner.destroy();
    }
    this.runners.clear();
  }
}
