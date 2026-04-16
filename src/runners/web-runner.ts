import { BaseRunner } from './base.js';
import type { ClientBoxConfig, RunOptions, RunResult } from '../types.js';

const CONSOLE_INTERCEPT_SCRIPT = `
<script>
(function() {
  var __cbStdout = [];
  var __cbStderr = [];

  function serialize(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a === null) parts.push('null');
      else if (a === undefined) parts.push('undefined');
      else if (typeof a === 'object') {
        try { parts.push(JSON.stringify(a, null, 2)); }
        catch(e) { parts.push(String(a)); }
      }
      else parts.push(String(a));
    }
    return parts.join(' ');
  }

  var origConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };

  console.log = function() { __cbStdout.push(serialize(arguments)); origConsole.log.apply(console, arguments); };
  console.info = function() { __cbStdout.push(serialize(arguments)); origConsole.info.apply(console, arguments); };
  console.debug = function() { __cbStdout.push(serialize(arguments)); origConsole.debug.apply(console, arguments); };
  console.warn = function() { __cbStderr.push(serialize(arguments)); origConsole.warn.apply(console, arguments); };
  console.error = function() { __cbStderr.push(serialize(arguments)); origConsole.error.apply(console, arguments); };

  window.addEventListener('error', function(e) {
    __cbStderr.push(e.message + (e.filename ? ' at ' + e.filename + ':' + e.lineno : ''));
  });

  window.addEventListener('unhandledrejection', function(e) {
    __cbStderr.push('Unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });

  window.__clientbox_getOutput = function() {
    return { stdout: __cbStdout.join('\\n'), stderr: __cbStderr.join('\\n') };
  };
})();
</script>
`;

export class WebRunner extends BaseRunner {
  private iframe: HTMLIFrameElement | null = null;
  private blobUrls: string[] = [];

  constructor(config: ClientBoxConfig) {
    super('web', config);
  }

  async run(options: RunOptions): Promise<RunResult> {
    this.assertBrowser();
    this.setStatus('running');
    const start = performance.now();
    const timeout = options.timeout ?? this.config.timeout ?? 30_000;

    try {
      const result = await this.withTimeout(
        this.executeInIframe(options),
        timeout
      );
      const duration = Math.round(performance.now() - start);
      this.setStatus('ready');
      return { ...result, duration };
    } catch (err) {
      this.cleanup();
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

  private executeInIframe(options: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.cleanup();

      const { files, entryPoint } = options;
      const htmlContent = files[entryPoint];
      if (htmlContent === undefined) {
        reject(new Error(`Entry point not found: ${entryPoint}`));
        return;
      }

      const blobMap = new Map<string, string>();
      for (const [path, content] of Object.entries(files)) {
        if (path === entryPoint) continue;
        const mime = this.getMimeType(path);
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        blobMap.set(path, url);
        this.blobUrls.push(url);
      }

      let resolvedHtml = htmlContent;
      for (const [path, blobUrl] of blobMap) {
        const relativePath = path.startsWith('/') ? path.slice(1) : path;
        const escaped = relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(
          `(src|href)=["'](\\.?\\/?)${escaped}["']`,
          'g'
        );
        resolvedHtml = resolvedHtml.replace(regex, `$1="${blobUrl}"`);
      }

      const headClose = resolvedHtml.indexOf('</head>');
      if (headClose !== -1) {
        resolvedHtml =
          resolvedHtml.slice(0, headClose) +
          CONSOLE_INTERCEPT_SCRIPT +
          resolvedHtml.slice(headClose);
      } else {
        resolvedHtml = CONSOLE_INTERCEPT_SCRIPT + resolvedHtml;
      }

      this.iframe = document.createElement('iframe');
      this.iframe.sandbox.add('allow-scripts');
      this.iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
      document.body.appendChild(this.iframe);

      this.iframe.srcdoc = resolvedHtml;

      const collectTimeout = setTimeout(() => {
        const output = this.collectOutput();
        this.cleanup();
        resolve({
          stdout: output.stdout,
          stderr: output.stderr,
          error: null,
          exitCode: 0,
          duration: 0,
        });
      }, 2000);

      this.iframe.addEventListener('load', () => {
        setTimeout(() => {
          clearTimeout(collectTimeout);
          const output = this.collectOutput();
          this.cleanup();
          resolve({
            stdout: output.stdout,
            stderr: output.stderr,
            error: output.stderr && !output.stdout ? output.stderr : null,
            exitCode: output.stderr && !output.stdout ? 1 : 0,
            duration: 0,
          });
        }, 500);
      });
    });
  }

  private collectOutput(): { stdout: string; stderr: string } {
    try {
      const win = this.iframe?.contentWindow as
        | (Window & { __clientbox_getOutput?: () => { stdout: string; stderr: string } })
        | null;
      if (win?.__clientbox_getOutput) {
        return win.__clientbox_getOutput();
      }
    } catch {
      // cross-origin restrictions
    }
    return { stdout: '', stderr: '' };
  }

  private getMimeType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    const mimes: Record<string, string> = {
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      mjs: 'application/javascript',
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
    };
    return mimes[ext || ''] || 'text/plain';
  }

  private cleanup(): void {
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
    for (const url of this.blobUrls) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls = [];
  }

  destroy(): void {
    this.cleanup();
    this.setStatus('destroyed');
  }
}
