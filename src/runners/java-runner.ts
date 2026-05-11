import { BaseRunner } from './base.js';
import type { ClientBoxConfig, RunOptions, RunResult } from '../types.js';

const DEFAULT_CHEERPJ_CDN = 'https://cjrtnc.leaningtech.com/4.2/loader.js';

/**
 * Builds the iframe harness that loads CheerpJ and provides a Java compilation
 * and execution environment. Uses CheerpJ's library mode to invoke javac and
 * then run the compiled class.
 */
function buildJavaHarness(cheerpjCdnUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script src="${cheerpjCdnUrl}"><\/script>
</head><body>
<script type="module">

let cjReady = false;
let pendingMessages = [];
let pendingInput = null;
let currentRunId = null;

window.addEventListener('message', function(e) {
  if (!e.data) return;
  if (e.data.type === 'clientbox-run') {
    if (cjReady) {
      handleRun(e.data);
    } else {
      pendingMessages.push(e.data);
    }
    return;
  }
  if (e.data.type === 'clientbox-input-response' && pendingInput && e.data.id === pendingInput.id) {
    var resolver = pendingInput.resolve;
    pendingInput = null;
    resolver(e.data.value);
  }
});

function requestInput(promptText) {
  return new Promise(function(resolve) {
    pendingInput = { id: currentRunId, resolve: resolve };
    parent.postMessage({
      type: 'clientbox-input-request',
      id: currentRunId,
      prompt: promptText || ''
    }, '*');
  });
}

async function initCheerpJ() {
  var timedOut = false;
  var initTimer = setTimeout(function() {
    timedOut = true;
    cjReady = true;
    parent.postMessage({ type: 'clientbox-ready', error: 'timeout' }, '*');
    for (var i = 0; i < pendingMessages.length; i++) {
      handleRun(pendingMessages[i]);
    }
    pendingMessages = [];
  }, 8000);

  try {
    if (typeof cheerpjInit !== 'function') throw new Error('CheerpJ not available');
    await cheerpjInit({
      status: 'none'
    });
    if (timedOut) return;
    clearTimeout(initTimer);
    cjReady = true;
    parent.postMessage({ type: 'clientbox-ready' }, '*');
    for (var i = 0; i < pendingMessages.length; i++) {
      handleRun(pendingMessages[i]);
    }
    pendingMessages = [];
  } catch(e) {
    if (timedOut) return;
    clearTimeout(initTimer);
    cjReady = true;
    parent.postMessage({ type: 'clientbox-ready', error: e.message || String(e) }, '*');
    for (var i = 0; i < pendingMessages.length; i++) {
      handleRun(pendingMessages[i]);
    }
    pendingMessages = [];
  }
}

async function handleRun(msg) {
  var stdout = [];
  var stderr = [];
  var error = null;
  var exitCode = 0;
  currentRunId = msg.id;

  var stdinLines = msg.stdin ? msg.stdin.split('\\n') : [];
  var stdinIndex = 0;

  function emitStdout(text) {
    stdout.push(text);
    parent.postMessage({ type: 'clientbox-stdout', id: msg.id, chunk: text }, '*');
  }

  async function readLineAsync() {
    if (stdinIndex < stdinLines.length) {
      var line = stdinLines[stdinIndex++];
      if (line === '' && stdinIndex === stdinLines.length) return null;
      return line;
    }
    return await requestInput('');
  }

  try {
    var files = msg.files || {};
    var entryPoint = msg.entryPoint;
    var code = files[entryPoint];
    if (!code) throw new Error('Entry point not found: ' + entryPoint);

    // CheerpJ path doesn't support our interactive input model; use transpiler for both.
    var result = await executeWithTranspiler(files, entryPoint, emitStdout, readLineAsync);
    stderr = result.stderr;
    error = result.error;
    exitCode = result.exitCode;
  } catch(err) {
    exitCode = 1;
    error = err.message || String(err);
    stderr.push(error);
  }

  parent.postMessage({
    type: 'clientbox-result',
    id: msg.id,
    stdout: stdout.join(''),
    stderr: stderr.join('\\n'),
    error: error,
    exitCode: exitCode
  }, '*');
}

async function executeWithCheerpJ(files, entryPoint) {
  var stdout = [];
  var stderr = [];
  var error = null;
  var exitCode = 0;

  try {
    // Write files to CheerpJ virtual FS
    var keys = Object.keys(files);
    for (var i = 0; i < keys.length; i++) {
      var path = keys[i];
      cheerpjAddStringFile('/str' + path, files[path]);
    }

    // Find the class with main method
    var code = files[entryPoint];
    var classMatch = code.match(/(?:public\\s+)?class\\s+(\\w+)/);
    if (!classMatch) throw new Error('No class found in ' + entryPoint);
    var className = classMatch[1];

    // Use library mode to compile and run
    var lib = await cheerpjRunLibrary('');

    // Set up output capturing via System.out
    var origOut = await lib.java.lang.System.out;

    // Attempt to compile via javax.tools
    try {
      var compiler = await lib.javax.tools.ToolProvider.getSystemJavaCompiler();
      if (compiler) {
        // Full compilation path available
        await cheerpjRunMain(className, '/str' + entryPoint.replace(/\\.java$/, ''));
      }
    } catch(compileErr) {
      // javax.tools may not be available, fall back to transpiler
      var result = executeWithTranspiler(files, entryPoint);
      return result;
    }
  } catch(e) {
    // Fall back to transpiler
    return executeWithTranspiler(files, entryPoint);
  }

  return { stdout: stdout, stderr: stderr, error: error, exitCode: exitCode };
}

async function executeWithTranspiler(files, entryPoint, emitStdout, readLineAsync) {
  var stderr = [];
  var error = null;
  var exitCode = 0;

  try {
    // Merge all Java files for class resolution
    var allCode = Object.keys(files)
      .filter(function(k) { return k.endsWith('.java'); })
      .map(function(k) { return files[k]; })
      .join('\\n');

    var jsCode = transpileJavaToJS(allCode, files[entryPoint]);
    var fakeSystem = {
      out: {
        println: function() {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            parts.push(arguments[i] === null ? 'null' :
                       arguments[i] === undefined ? '' : String(arguments[i]));
          }
          emitStdout(parts.join(' ') + '\\n');
        },
        print: function() {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            parts.push(arguments[i] === null ? 'null' :
                       arguments[i] === undefined ? '' : String(arguments[i]));
          }
          emitStdout(parts.join(' '));
        },
        printf: function(fmt) {
          var args = Array.prototype.slice.call(arguments, 1);
          var idx = 0;
          var result = fmt.replace(/%[sdfc%]/g, function(m) {
            if (m === '%%') return '%';
            if (idx >= args.length) return m;
            return String(args[idx++]);
          });
          emitStdout(result);
        },
        in: 'STDIN'
      },
      err: {
        println: function(msg) { stderr.push(String(msg)); },
        print: function(msg) { stderr.push(String(msg)); }
      }
    };

    var Scanner = {
      nextLine: async function() { return await readLineAsync(); },
      nextInt: async function() {
        var line = await readLineAsync();
        return parseInt(line, 10);
      },
      nextDouble: async function() {
        var line = await readLineAsync();
        return parseFloat(line);
      },
      hasNext: function() { return true; },
      hasNextLine: function() { return true; },
      close: function() {}
    };

    var AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    var fn = new AsyncFunction('System', 'Math', 'Integer', 'Double', 'String', 'Scanner', jsCode);
    await fn(fakeSystem, Math, {
      parseInt: function(s) { return parseInt(s, 10); },
      valueOf: function(v) { return v; },
      MAX_VALUE: 2147483647,
      MIN_VALUE: -2147483648,
      toString: function(v) { return String(v); }
    }, {
      parseDouble: function(s) { return parseFloat(s); },
      valueOf: function(v) { return v; }
    }, {
      valueOf: function(v) { return String(v); },
      format: function(fmt) {
        var args = Array.prototype.slice.call(arguments, 1);
        var idx = 0;
        return fmt.replace(/%[sdfc%]/g, function(m) {
          if (m === '%%') return '%';
          if (idx >= args.length) return m;
          return String(args[idx++]);
        });
      }
    }, Scanner);
  } catch(e) {
    exitCode = 1;
    error = e.message || String(e);
    stderr.push(error);
  }

  return { stderr: stderr, error: error, exitCode: exitCode };
}

function javaExtractBraceBlock(src, openIdx) {
  var depth = 1;
  var i = openIdx + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return { body: src.substring(openIdx + 1, i - 1), endIdx: i };
}

function transpileJavaToJS(allCode, entryCode) {
  var code = allCode || entryCode;

  var lines = code.split('\\n');
  var filtered = [];
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (trimmed.startsWith('package ') && trimmed.endsWith(';')) continue;
    if (trimmed.startsWith('import ') && trimmed.endsWith(';')) continue;
    filtered.push(lines[i]);
  }
  var body = filtered.join('\\n');

  // Find all method signatures
  var methodRe = /(?:public\\s+|private\\s+|protected\\s+)*(?:static\\s+)?(?:void|int|long|float|double|boolean|char|byte|short|String|Object|List|Map|Set|Optional)(?:\\[\\])?\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{/g;

  var methods = [];
  var mainBody = null;
  var match;

  while ((match = methodRe.exec(body)) !== null) {
    var name = match[1];
    var params = match[2];
    var openBrace = body.indexOf('{', match.index + match[0].length - 1);
    var block = javaExtractBraceBlock(body, openBrace);

    if (name === 'main') {
      mainBody = block.body;
    } else {
      var jsParams = params.split(',').map(function(p) {
        var parts = p.trim().split(/\\s+/);
        return parts[parts.length - 1] || '';
      }).filter(function(p) { return p; }).join(', ');

      methods.push({ name: name, params: jsParams, body: block.body });
    }
  }

  var output = '';

  for (var m = 0; m < methods.length; m++) {
    var transformedBody = transformJavaBody(methods[m].body);
    var needsAsync = transformedBody.indexOf('await ') !== -1;
    output += (needsAsync ? 'async ' : '') + 'function ' + methods[m].name + '(' + methods[m].params + ') {\\n';
    output += transformedBody;
    output += '\\n}\\n\\n';
  }

  // Create namespace objects for user classes so ClassName.method() calls resolve
  var classRe = /class\\s+(\\w+)/g;
  var cm;
  while ((cm = classRe.exec(body)) !== null) {
    var cls = cm[1];
    if (cls === 'Main') continue;
    var parts = [];
    for (var n = 0; n < methods.length; n++) {
      parts.push(methods[n].name + ': ' + methods[n].name);
    }
    output += 'var ' + cls + ' = { ' + parts.join(', ') + ' };\\n';
  }

  if (mainBody !== null) {
    output += transformJavaBody(mainBody);
  } else {
    output += transformJavaBody(body);
  }

  return output;
}

function transformJavaBody(body) {
  var result = body;

  // Scanner declarations: Scanner sc = new Scanner(System.in); -> var sc = Scanner;
  result = result.replace(/\\bScanner\\s+(\\w+)\\s*=\\s*new\\s+Scanner\\s*\\([^)]*\\)/g, 'var $1 = Scanner');
  result = result.replace(/\\bScanner\\s+(\\w+)\\s*;/g, 'var $1 = Scanner;');

  // Wrap blocking Scanner method calls with await. These take no args, so the regex is safe.
  result = result.replace(/\\b(\\w+)\\.nextLine\\s*\\(\\s*\\)/g, '(await $1.nextLine())');
  result = result.replace(/\\b(\\w+)\\.nextInt\\s*\\(\\s*\\)/g, '(await $1.nextInt())');
  result = result.replace(/\\b(\\w+)\\.nextDouble\\s*\\(\\s*\\)/g, '(await $1.nextDouble())');

  // Type declarations: int x = 5; -> var x = 5;
  result = result.replace(
    /\\b(int|long|float|double|boolean|char|byte|short|String|var|Object)\\s+(\\w+)\\s*=/g,
    'var $2 ='
  );
  result = result.replace(
    /\\b(int|long|float|double|boolean|char|byte|short|String|Object)\\s+(\\w+)\\s*;/g,
    'var $2;'
  );

  // Array declarations: int[] arr = new int[]{1,2,3}; -> var arr = [1,2,3];
  result = result.replace(/\\b(int|long|float|double|boolean|char|String|Object)\\[\\]\\s+(\\w+)\\s*=\\s*new\\s+\\w+\\[\\]\\s*\\{([^}]*)\\}/g,
    'var $2 = [$3]');
  result = result.replace(/\\b(int|long|float|double|boolean|char|String|Object)\\[\\]\\s+(\\w+)\\s*=\\s*\\{([^}]*)\\}/g,
    'var $2 = [$3]');
  result = result.replace(/new\\s+\\w+\\[\\]\\s*\\{([^}]*)\\}/g, '[$1]');
  result = result.replace(/new\\s+\\w+\\[(\\d+)\\]/g, 'new Array($1).fill(0)');

  // ArrayList -> array
  result = result.replace(/new\\s+ArrayList<[^>]*>\\(\\)/g, '[]');
  result = result.replace(/\\.(add)\\(/g, '.push(');
  result = result.replace(/\\.size\\(\\)/g, '.length');
  result = result.replace(/\\.get\\(/g, '[');
  result = result.replace(/\\.get\\(([^)]+)\\)/g, '[$1]');

  // String methods
  result = result.replace(/\\.length\\(\\)/g, '.length');
  result = result.replace(/\\.charAt\\(/g, '.charAt(');
  result = result.replace(/\\.substring\\(/g, '.substring(');
  result = result.replace(/\\.equals\\(/g, ' === ');
  result = result.replace(/\\.equalsIgnoreCase\\(([^)]+)\\)/g, '.toLowerCase() === $1.toLowerCase()');
  result = result.replace(/\\.toUpperCase\\(\\)/g, '.toUpperCase()');
  result = result.replace(/\\.toLowerCase\\(\\)/g, '.toLowerCase()');
  result = result.replace(/\\.contains\\(/g, '.includes(');
  result = result.replace(/\\.indexOf\\(/g, '.indexOf(');
  result = result.replace(/\\.replace\\(/g, '.replace(');
  result = result.replace(/\\.trim\\(\\)/g, '.trim()');
  result = result.replace(/\\.split\\(/g, '.split(');
  result = result.replace(/\\.isEmpty\\(\\)/g, ' === ""');

  // for-each: for (Type x : collection) -> for (var x of collection)
  result = result.replace(
    /for\\s*\\(\\s*(?:final\\s+)?(?:int|long|float|double|boolean|char|String|var|\\w+)\\s+(\\w+)\\s*:\\s*/g,
    'for (var $1 of '
  );

  // boolean literals
  result = result.replace(/\\btrue\\b/g, 'true');
  result = result.replace(/\\bfalse\\b/g, 'false');

  // null
  result = result.replace(/\\bnull\\b/g, 'null');

  // System.out mapping already handled by the injected System object

  // Math methods are compatible

  return result;
}

initCheerpJ();

<\/script>
</body></html>`;
}

export class JavaRunner extends BaseRunner {
  private iframe: HTMLIFrameElement | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(config: ClientBoxConfig) {
    super('java', config);
  }

  private async ensureIframe(): Promise<HTMLIFrameElement> {
    if (this.iframe && this.readyPromise) {
      await this.readyPromise;
      return this.iframe!;
    }

    this.setStatus('loading', 'Initializing Java runtime (CheerpJ)...');

    this.iframe = document.createElement('iframe');
    this.iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
    this.iframe.setAttribute('allow', 'cross-origin-isolated');
    document.body.appendChild(this.iframe);

    const cdnUrl = this.config.cheerpjCdnUrl || DEFAULT_CHEERPJ_CDN;
    const harness = buildJavaHarness(cdnUrl);

    const iframe = this.iframe;
    this.readyPromise = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.type === 'clientbox-ready') {
          window.removeEventListener('message', handler);
          this.setStatus('ready', 'Java runtime ready');
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
      let pendingStdout = '';

      const handler = async (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        const data = e.data;
        if (!data || data.id !== id) return;
        if (data.type === 'clientbox-stdout') {
          pendingStdout += data.chunk;
          options.onStdout?.(data.chunk);
          return;
        }
        if (data.type === 'clientbox-stderr') {
          options.onStderr?.(data.chunk);
          return;
        }
        if (data.type === 'clientbox-input-request') {
          const promptText = pendingStdout || data.prompt || '';
          pendingStdout = '';
          let value: string | null = null;
          if (options.onInput) {
            try {
              value = await options.onInput(promptText);
            } catch {
              value = null;
            }
          }
          iframe.contentWindow!.postMessage(
            { type: 'clientbox-input-response', id, value },
            '*'
          );
          return;
        }
        if (data.type === 'clientbox-result') {
          window.removeEventListener('message', handler);
          resolve({
            stdout: data.stdout || '',
            stderr: data.stderr || '',
            error: data.error || null,
            exitCode: data.exitCode ?? 0,
            duration: 0,
          });
        }
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
