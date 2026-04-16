import { BaseRunner } from './base.js';
import type { ClientBoxConfig, RunOptions, RunResult } from '../types.js';

function buildPhpHarness(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<script>

var runtimeReady = false;
var pendingMessages = [];

window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'clientbox-run') {
    if (runtimeReady) {
      handleRun(e.data);
    } else {
      pendingMessages.push(e.data);
    }
  }
});

function handleRun(msg) {
  var stdout = [];
  var stderr = [];
  var error = null;
  var exitCode = 0;

  try {
    var files = msg.files || {};
    var entryPoint = msg.entryPoint;
    var code = files[entryPoint];
    if (!code) throw new Error('Entry point not found: ' + entryPoint);

    var allCode = Object.keys(files).map(function(k) { return files[k]; }).join('\\n');
    var result = executePhp(allCode);
    stdout = result.stdout;
    stderr = result.stderr;
    if (result.error) {
      error = result.error;
      exitCode = 1;
    }
  } catch(err) {
    exitCode = 1;
    error = err.message || String(err);
    stderr.push(error);
  }

  parent.postMessage({
    type: 'clientbox-result',
    id: msg.id,
    stdout: stdout.join('\\n'),
    stderr: stderr.join('\\n'),
    error: error,
    exitCode: exitCode
  }, '*');
}

function executePhp(code) {
  var stdout = [];
  var stderr = [];
  var error = null;

  try {
    var jsCode = transpilePhpToJS(code);
    var fn = new Function('__echo', '__stdout', jsCode);
    fn(function() {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        parts.push(arguments[i] === null ? 'null' :
                   arguments[i] === undefined ? '' : String(arguments[i]));
      }
      stdout.push(parts.join(''));
    }, stdout);
  } catch(e) {
    error = e.message || String(e);
    stderr.push(error);
  }

  return { stdout: stdout, stderr: stderr, error: error };
}

function transpilePhpToJS(code) {
  // Strip <?php and ?> tags
  code = code.replace(/<\\?php/gi, '').replace(/<\\?/g, '').replace(/\\?>/g, '');
  var lines = code.split('\\n');
  var output = [];

  // Built-in PHP function implementations
  output.push('var __vars = {};');
  output.push('function array_push(arr) { for (var i = 1; i < arguments.length; i++) arr.push(arguments[i]); return arr.length; }');
  output.push('function array_pop(arr) { return arr.pop(); }');
  output.push('function array_shift(arr) { return arr.shift(); }');
  output.push('function array_reverse(arr) { return arr.slice().reverse(); }');
  output.push('function array_merge() { var r = []; for (var i = 0; i < arguments.length; i++) r = r.concat(arguments[i]); return r; }');
  output.push('function array_map(fn, arr) { return arr.map(fn); }');
  output.push('function array_filter(arr, fn) { return fn ? arr.filter(fn) : arr.filter(function(v) { return !!v; }); }');
  output.push('function count(a) { return a.length; }');
  output.push('function strlen(s) { return s.length; }');
  output.push('function strtolower(s) { return s.toLowerCase(); }');
  output.push('function strtoupper(s) { return s.toUpperCase(); }');
  output.push('function ucfirst(s) { return s.charAt(0).toUpperCase() + s.slice(1); }');
  output.push('function lcfirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }');
  output.push('function str_repeat(s, n) { return s.repeat(n); }');
  output.push('function str_replace(search, replace, subject) { return subject.split(search).join(replace); }');
  output.push('function substr(s, start, len) { return len !== undefined ? s.substr(start, len) : s.substr(start); }');
  output.push('function strpos(haystack, needle) { var i = haystack.indexOf(needle); return i === -1 ? false : i; }');
  output.push('function explode(delim, str) { return str.split(delim); }');
  output.push('function implode(glue, arr) { return arr.join(glue); }');
  output.push('function trim(s) { return s.trim(); }');
  output.push('function ltrim(s) { return s.replace(/^\\\\s+/, ""); }');
  output.push('function rtrim(s) { return s.replace(/\\\\s+$/, ""); }');
  output.push('function intval(v) { return parseInt(v, 10) || 0; }');
  output.push('function floatval(v) { return parseFloat(v) || 0; }');
  output.push('function strval(v) { return String(v); }');
  output.push('function is_array(v) { return Array.isArray(v); }');
  output.push('function is_string(v) { return typeof v === "string"; }');
  output.push('function is_numeric(v) { return !isNaN(parseFloat(v)) && isFinite(v); }');
  output.push('function in_array(needle, haystack) { return haystack.indexOf(needle) !== -1; }');
  output.push('function array_key_exists(key, obj) { return obj.hasOwnProperty(key); }');
  output.push('function array_keys(obj) { return Object.keys(obj); }');
  output.push('function array_values(obj) { return Array.isArray(obj) ? obj.slice() : Object.values(obj); }');
  output.push('function sort(arr) { arr.sort(); return true; }');
  output.push('function rsort(arr) { arr.sort().reverse(); return true; }');
  output.push('function range(start, end) { var r = []; for (var i = start; i <= end; i++) r.push(i); return r; }');
  output.push('function max() { var a = arguments.length === 1 && Array.isArray(arguments[0]) ? arguments[0] : Array.from(arguments); return Math.max.apply(null, a); }');
  output.push('function min() { var a = arguments.length === 1 && Array.isArray(arguments[0]) ? arguments[0] : Array.from(arguments); return Math.min.apply(null, a); }');
  output.push('function abs(n) { return Math.abs(n); }');
  output.push('function ceil(n) { return Math.ceil(n); }');
  output.push('function floor(n) { return Math.floor(n); }');
  output.push('function round(n, p) { var f = Math.pow(10, p || 0); return Math.round(n * f) / f; }');
  output.push('function pow(b, e) { return Math.pow(b, e); }');
  output.push('function sqrt(n) { return Math.sqrt(n); }');
  output.push('function rand(mn, mx) { mn = mn || 0; mx = mx || 2147483647; return Math.floor(Math.random() * (mx - mn + 1)) + mn; }');
  output.push('function number_format(n, d) { return Number(n).toFixed(d || 0); }');
  output.push('function sprintf() { var fmt = arguments[0]; var idx = 1; return fmt.replace(/%([sd])/g, function(_, t) { return idx < arguments.length ? (t === "d" ? parseInt(arguments[idx++]) : String(arguments[idx++])) : ""; }.bind(null)); }');
  output.push('function print_r(v) { __echo(typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)); }');
  output.push('function var_dump(v) { __echo(typeof v + "(" + JSON.stringify(v) + ")"); }');
  output.push('function json_encode(v) { return JSON.stringify(v); }');
  output.push('function json_decode(s) { return JSON.parse(s); }');
  output.push('');

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();
    if (!trimmed) { output.push(''); continue; }
    if (/^(require_once|require|include_once|include)\\b/.test(trimmed)) continue;

    // echo / print
    trimmed = trimmed.replace(/^echo\\s+/i, '__echo(');
    if (trimmed.startsWith('__echo(') && !trimmed.endsWith('{')) {
      trimmed = trimmed.replace(/;\\s*$/, '') + ');';
    }
    trimmed = trimmed.replace(/^print\\s+/i, '__echo(');
    if (trimmed.startsWith('__echo(') && !trimmed.endsWith(')') && !trimmed.endsWith(');')) {
      trimmed = trimmed.replace(/;\\s*$/, '') + ');';
    }

    // $ variable prefix -> remove
    trimmed = trimmed.replace(/\\$(\\w+)/g, '__v_$1');

    // . string concat -> +
    trimmed = trimmed.replace(/\\s*\\.\\s*/g, ' + ');

    // function declarations are compatible
    // foreach ($arr as $val) -> for (var __v_val of __v_arr)
    trimmed = trimmed.replace(
      /foreach\\s*\\(\\s*(__v_\\w+)\\s+as\\s+(__v_\\w+)\\s*=>\\s*(__v_\\w+)\\s*\\)/g,
      'for (var [$2, $3] of Object.entries($1))'
    );
    trimmed = trimmed.replace(
      /foreach\\s*\\(\\s*(__v_\\w+)\\s+as\\s+(__v_\\w+)\\s*\\)/g,
      'for (var $2 of $1)'
    );

    // for loops are mostly compatible after $ removal

    // array() -> []
    trimmed = trimmed.replace(/array\\s*\\(/g, '[');
    trimmed = trimmed.replace(/\\)\\s*;/, function(m) {
      return m;
    });

    // => in arrays -> : (for associative arrays)
    // This is a simplified transform

    output.push(trimmed);
  }

  return output.join('\\n');
}

runtimeReady = true;
parent.postMessage({ type: 'clientbox-ready' }, '*');
for (var i = 0; i < pendingMessages.length; i++) {
  handleRun(pendingMessages[i]);
}
pendingMessages = [];

<\/script>
</body></html>`;
}

export class PhpRunner extends BaseRunner {
  private iframe: HTMLIFrameElement | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(config: ClientBoxConfig) {
    super('php', config);
  }

  private async ensureIframe(): Promise<HTMLIFrameElement> {
    if (this.iframe && this.readyPromise) {
      await this.readyPromise;
      return this.iframe!;
    }

    this.setStatus('loading', 'Initializing PHP runtime...');

    this.iframe = document.createElement('iframe');
    this.iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
    document.body.appendChild(this.iframe);

    const harness = buildPhpHarness();

    const iframe = this.iframe;
    this.readyPromise = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.type === 'clientbox-ready') {
          window.removeEventListener('message', handler);
          this.setStatus('ready', 'PHP runtime ready');
          resolve();
        }
      };
      window.addEventListener('message', handler);
    });

    this.iframe.srcdoc = harness;
    await this.readyPromise;
    return this.iframe;
  }

  async run(options: RunOptions): Promise<RunResult> {
    this.assertBrowser();
    const start = performance.now();
    const timeout = options.timeout ?? this.config.timeout ?? 30_000;
    const id = this.generateId();

    try {
      const result = await this.withTimeout(
        (async () => {
          const iframe = await this.ensureIframe();
          this.setStatus('running');
          return this.executeInIframe(iframe, id, options);
        })(),
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

  private executeInIframe(
    iframe: HTMLIFrameElement,
    id: string,
    options: RunOptions
  ): Promise<RunResult> {
    return new Promise((resolve, _reject) => {
      const handler = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.type !== 'clientbox-result' || e.data?.id !== id) return;
        window.removeEventListener('message', handler);
        resolve({
          stdout: e.data.stdout || '',
          stderr: e.data.stderr || '',
          error: e.data.error || null,
          exitCode: e.data.exitCode ?? 0,
          duration: 0,
        });
      };

      window.addEventListener('message', handler);

      iframe.contentWindow!.postMessage(
        {
          type: 'clientbox-run',
          id,
          files: options.files,
          entryPoint: options.entryPoint,
          stdin: options.stdin,
        },
        '*'
      );
    });
  }

  private cleanup(): void {
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
      this.readyPromise = null;
    }
  }

  destroy(): void {
    this.cleanup();
    this.setStatus('destroyed');
  }
}
