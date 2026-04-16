import { BaseRunner } from './base.js';
import type { ClientBoxConfig, RunOptions, RunResult } from '../types.js';

function buildDartHarness(): string {
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
    var result = executeDart(allCode);
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

function executeDart(code) {
  var stdout = [];
  var stderr = [];
  var error = null;

  try {
    var jsCode = transpileDartToJS(code);
    var fn = new Function('__print', jsCode);
    fn(function() {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        parts.push(arguments[i] === null ? 'null' :
                   arguments[i] === undefined ? '' : String(arguments[i]));
      }
      stdout.push(parts.join(''));
    });
  } catch(e) {
    error = e.message || String(e);
    stderr.push(error);
  }

  return { stdout: stdout, stderr: stderr, error: error };
}

function extractBraceBlock(src, openIdx) {
  var depth = 1;
  var i = openIdx + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return { body: src.substring(openIdx + 1, i - 1), endIdx: i };
}

function transpileDartToJS(code) {
  var lines = code.split('\\n');
  var filtered = [];
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (trimmed.startsWith('import ')) continue;
    filtered.push(lines[i]);
  }
  var body = filtered.join('\\n');

  // Find all top-level and class-level functions
  var functionRe = /(?:static\\s+)?(?:Future<[^>]+>\\s+|void\\s+|int\\s+|double\\s+|num\\s+|bool\\s+|String\\s+|List<[^>]+>\\s+|Map<[^,>]+,[^>]+>\\s+|dynamic\\s+|var\\s+|Set<[^>]+>\\s+)(\\w+)\\s*\\(([^)]*)\\)\\s*(?:async\\s*)?\\{/g;

  var functions = [];
  var mainBody = null;
  var match;

  while ((match = functionRe.exec(body)) !== null) {
    var name = match[1];
    var params = match[2];
    var openBrace = body.indexOf('{', match.index + match[0].length - 1);
    var block = extractBraceBlock(body, openBrace);

    if (name === 'main') {
      mainBody = block.body;
    } else {
      var jsParams = params.split(',').map(function(p) {
        var parts = p.trim().split(/\\s+/);
        if (parts.length === 0 || (parts.length === 1 && !parts[0])) return '';
        return parts[parts.length - 1].replace(/[?]$/, '');
      }).filter(function(p) { return p; }).join(', ');

      functions.push({
        name: name,
        params: jsParams,
        body: block.body
      });
    }
  }

  var output = [];

  // Dart built-in helpers
  output.push('var __List = { filled: function(n, v) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }, generate: function(n, fn) { var a = []; for (var i = 0; i < n; i++) a.push(fn(i)); return a; } };');
  output.push('function List_from(iter) { return Array.from(iter); }');
  output.push('');

  // Emit helper functions first
  for (var m = 0; m < functions.length; m++) {
    output.push('function ' + functions[m].name + '(' + functions[m].params + ') {');
    output.push(transformDartBody(functions[m].body));
    output.push('}');
    output.push('');
  }

  // Emit main body
  if (mainBody !== null) {
    output.push(transformDartBody(mainBody));
  } else {
    output.push(transformDartBody(body));
  }

  return output.join('\\n');
}

function transformDartBody(body) {
  var result = body;

  // print() -> __print()
  result = result.replace(/\\bprint\\s*\\(/g, '__print(');

  // Dart string interpolation: dollar-var and dollar-brace-expr -> JS template literal
  // Convert single-quoted strings with interpolation to template literals
  result = result.replace(/'([^']*\\$[^']*)'/g, function(_, inner) {
    var converted = inner
      .replace(/\\$\\{([^}]+)\\}/g, function(_m, expr) { return '\\x24{' + expr + '}'; })
      .replace(/\\$(\\w+)/g, function(_m, v) { return '\\x24{' + v + '}'; });
    return '\\x60' + converted + '\\x60';
  });

  // Variable declarations: int x = 5; -> var x = 5;
  result = result.replace(
    /\\b(int|double|num|bool|String|dynamic|var|final|const)\\s+(\\w+)\\s*=/g,
    'var $2 ='
  );
  result = result.replace(
    /\\b(int|double|num|bool|String|dynamic)\\s+(\\w+)\\s*;/g,
    'var $2;'
  );

  // List<T> x = [...] -> var x = [...]
  result = result.replace(/\\bList<[^>]+>\\s+(\\w+)\\s*=/g, 'var $1 =');
  result = result.replace(/\\bMap<[^,>]+,[^>]+>\\s+(\\w+)\\s*=/g, 'var $1 =');
  result = result.replace(/\\bSet<[^>]+>\\s+(\\w+)\\s*=/g, 'var $1 =');

  // for (var x in items) -> for (var x of items)
  result = result.replace(/\\bfor\\s*\\(\\s*(var|final|int|String)\\s+(\\w+)\\s+in\\s+/g,
    'for (var $2 of ');

  // .length is the same
  // .isEmpty -> .length === 0
  result = result.replace(/\\.isEmpty\\b/g, '.length === 0');
  // .isNotEmpty -> .length > 0
  result = result.replace(/\\.isNotEmpty\\b/g, '.length > 0');

  // .toString() is the same
  // .toInt() -> parseInt()
  result = result.replace(/(\\w+)\\.toInt\\(\\)/g, 'parseInt($1)');
  // .toDouble() -> parseFloat()
  result = result.replace(/(\\w+)\\.toDouble\\(\\)/g, 'parseFloat($1)');
  // .abs() -> Math.abs()
  result = result.replace(/(\\w+)\\.abs\\(\\)/g, 'Math.abs($1)');

  // .add(x) -> .push(x) for lists
  result = result.replace(/\\.add\\(/g, '.push(');
  // .addAll(x) -> .push(...x)
  result = result.replace(/\\.addAll\\(([^)]+)\\)/g, '.push(...$1)');
  // .removeLast() -> .pop()
  result = result.replace(/\\.removeLast\\(\\)/g, '.pop()');
  // .contains(x) -> .includes(x)
  result = result.replace(/\\.contains\\(/g, '.includes(');
  // .sublist(a, b) -> .slice(a, b)
  result = result.replace(/\\.sublist\\(/g, '.slice(');
  // .join(x) is the same
  // .map(x).toList() -> [...].map(x)
  result = result.replace(/\\.toList\\(\\)/g, '');

  // ~/ integer division -> Math.floor(a/b)
  result = result.replace(/(\\w+)\\s*~\\/\\s*(\\w+)/g, 'Math.floor($1 / $2)');

  // 'as int' / 'as double' / etc type casts -> remove
  result = result.replace(/\\bas\\s+(int|double|num|String|bool|dynamic)\\b/g, '');

  return result;
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

export class DartRunner extends BaseRunner {
  private iframe: HTMLIFrameElement | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(config: ClientBoxConfig) {
    super('dart', config);
  }

  private async ensureIframe(): Promise<HTMLIFrameElement> {
    if (this.iframe && this.readyPromise) {
      await this.readyPromise;
      return this.iframe!;
    }

    this.setStatus('loading', 'Initializing Dart runtime...');

    this.iframe = document.createElement('iframe');
    this.iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
    document.body.appendChild(this.iframe);

    const harness = buildDartHarness();

    const iframe = this.iframe;
    this.readyPromise = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.type === 'clientbox-ready') {
          window.removeEventListener('message', handler);
          this.setStatus('ready', 'Dart runtime ready');
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
