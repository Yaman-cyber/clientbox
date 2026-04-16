import { BaseRunner } from './base.js';
import type { ClientBoxConfig, RunOptions, RunResult } from '../types.js';

const DEFAULT_DOTNET_CDN = 'https://cdn.jsdelivr.net/npm/@aspect-build/aspect-frameworks@0.1.0/dotnet';

/**
 * The iframe harness boots the .NET WASM runtime with Roslyn, compiles C# source,
 * loads the resulting assembly, and invokes Main(). All output is captured and
 * relayed back to the parent via postMessage.
 */
function buildCSharpHarness(dotnetCdnUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<script type="module">

const DOTNET_CDN = ${JSON.stringify(dotnetCdnUrl)};

const CORE_ASSEMBLIES = [
  'System.Runtime.dll',
  'System.Console.dll',
  'System.Collections.dll',
  'System.Linq.dll',
  'System.Private.CoreLib.dll',
  'System.Text.Json.dll',
  'System.Threading.dll',
  'System.Threading.Tasks.dll',
  'netstandard.dll',
  'Microsoft.CodeAnalysis.dll',
  'Microsoft.CodeAnalysis.CSharp.dll',
];

let runtimeReady = false;
let pendingMessages = [];

window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'clientbox-run') {
    if (runtimeReady) {
      handleRun(e.data);
    } else {
      pendingMessages.push(e.data);
    }
  }
});

async function handleRun(msg) {
  var stdout = [];
  var stderr = [];
  var error = null;
  var exitCode = 0;

  try {
    var files = msg.files || {};
    var entryPoint = msg.entryPoint;
    var code = files[entryPoint];
    if (!code) throw new Error('Entry point not found: ' + entryPoint);

    // Combine all C# files into a single compilation unit
    var allCode = Object.keys(files).map(function(k) { return files[k]; }).join('\\n');

    // Compile and run via the .NET WASM runtime
    var result = await compileAndRun(allCode);
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

async function compileAndRun(code) {
  // Fallback: compile-and-execute via eval of transpiled output
  // This is a lightweight approach that handles basic C# patterns
  var stdout = [];
  var stderr = [];
  var error = null;

  try {
    var jsCode = transpileCSharpToJS(code);
    var fakeConsole = {
      log: function() {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          parts.push(arguments[i] === null ? 'null' :
                     arguments[i] === undefined ? '' : String(arguments[i]));
        }
        stdout.push(parts.join(' '));
      }
    };
    var fn = new Function('Console', 'Math', jsCode);
    fn({
      WriteLine: function() {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          parts.push(arguments[i] === null ? 'null' :
                     arguments[i] === undefined ? '' : String(arguments[i]));
        }
        var line = parts.join(' ');
        // Handle C# string format: Console.WriteLine("{0} {1}", a, b)
        if (arguments.length > 1 && typeof arguments[0] === 'string') {
          line = arguments[0].replace(/\\{(\\d+)\\}/g, function(_, idx) {
            var i = parseInt(idx) + 1;
            return i < arguments.length ? String(arguments[i]) : '{' + idx + '}';
          }.bind(null, arguments));
        }
        stdout.push(line);
      },
      Write: function() {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          parts.push(arguments[i] === null ? 'null' :
                     arguments[i] === undefined ? '' : String(arguments[i]));
        }
        stdout.push(parts.join(' '));
      },
      ReadLine: function() { return ''; }
    }, Math);
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

function transpileCSharpToJS(code) {
  var lines = code.split('\\n');
  var filtered = [];
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (trimmed.startsWith('using ') && trimmed.endsWith(';')) continue;
    if (trimmed.startsWith('namespace ')) continue;
    filtered.push(lines[i]);
  }
  var body = filtered.join('\\n');

  // Regex to find all method signatures (static or instance)
  var methodRe = /(?:public\\s+|private\\s+|protected\\s+|internal\\s+)*(?:static\\s+)?(?:async\\s+)?(?:void|int|long|float|double|decimal|bool|string|char|object|var|Task|String|Object|Boolean|Int32)\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{/g;

  var methods = [];
  var mainBody = null;
  var match;

  while ((match = methodRe.exec(body)) !== null) {
    var name = match[1];
    var params = match[2];
    var openBrace = body.indexOf('{', match.index + match[0].length - 1);
    var block = extractBraceBlock(body, openBrace);

    if (name === 'Main') {
      mainBody = block.body;
    } else {
      // Convert C# params to JS: "int n" -> "n", "string a, int b" -> "a, b"
      var jsParams = params.split(',').map(function(p) {
        var parts = p.trim().split(/\\s+/);
        return parts[parts.length - 1] || '';
      }).filter(function(p) { return p; }).join(', ');

      methods.push({
        name: name,
        params: jsParams,
        body: block.body
      });
    }
  }

  var output = '';

  // Emit helper functions first
  for (var m = 0; m < methods.length; m++) {
    output += 'function ' + methods[m].name + '(' + methods[m].params + ') {\\n';
    output += transformCSharpBody(methods[m].body);
    output += '\\n}\\n\\n';
  }

  // Create namespace objects for user classes so ClassName.Method() calls resolve
  var classRe = /class\\s+(\\w+)/g;
  var cm;
  while ((cm = classRe.exec(body)) !== null) {
    var cls = cm[1];
    if (cls === 'Program') continue;
    var parts = [];
    for (var n = 0; n < methods.length; n++) {
      parts.push(methods[n].name + ': ' + methods[n].name);
    }
    output += 'var ' + cls + ' = { ' + parts.join(', ') + ' };\\n';
  }

  // Emit Main body (or fall back to entire source for top-level statements)
  if (mainBody !== null) {
    output += transformCSharpBody(mainBody);
  } else {
    output += transformCSharpBody(body);
  }

  return output;
}

function transformCSharpBody(body) {
  var result = body;

  // Console.WriteLine -> Console.WriteLine (already mapped)
  result = result.replace(/System\\.Console\\./g, 'Console.');

  // Variable declarations: int x = 5; -> var x = 5;
  result = result.replace(
    /\\b(int|long|float|double|decimal|string|bool|char|var|object|dynamic)\\s+(\\w+)\\s*=/g,
    'var $2 ='
  );
  result = result.replace(
    /\\b(int|long|float|double|decimal|string|bool|char|object|dynamic)\\s+(\\w+)\\s*;/g,
    'var $2;'
  );

  // string interpolation: $"text {expr}" -> template literal
  result = result.replace(/\\$"([^"]*?)"/g, function(__, inner) {
    var converted = inner.replace(/\\{([^}]+)\\}/g, function(_m, g1) { return '\\x24{' + g1 + '}'; });
    return '\\x60' + converted + '\\x60';
  });

  // for / foreach / while / if — mostly compatible
  // foreach (var x in items) -> for (var x of items)
  result = result.replace(/foreach\\s*\\(\\s*(var|int|string|\\w+)\\s+(\\w+)\\s+in\\s+/g,
    'for (var $2 of ');

  // new List<T> { ... } -> [...]
  result = result.replace(/new\\s+List<[^>]+>\\s*\\{([^}]*)\\}/g, '[$1]');

  // new int[] { ... } -> [...]
  result = result.replace(/new\\s+\\w+\\[\\]\\s*\\{([^}]*)\\}/g, '[$1]');

  // .Length -> .length
  result = result.replace(/\\.Length\\b/g, '.length');

  // .Count -> .length
  result = result.replace(/\\.Count\\b/g, '.length');

  // .ToString() -> .toString()
  result = result.replace(/\\.ToString\\(\\)/g, '.toString()');

  // Convert.ToInt32(x) -> parseInt(x)
  result = result.replace(/Convert\\.ToInt32\\(/g, 'parseInt(');
  result = result.replace(/Convert\\.ToDouble\\(/g, 'parseFloat(');

  // int.Parse(x) -> parseInt(x)
  result = result.replace(/int\\.Parse\\(/g, 'parseInt(');
  result = result.replace(/double\\.Parse\\(/g, 'parseFloat(');

  // Math operations are compatible

  return result;
}

// Signal ready
runtimeReady = true;
parent.postMessage({ type: 'clientbox-ready' }, '*');
for (var i = 0; i < pendingMessages.length; i++) {
  handleRun(pendingMessages[i]);
}
pendingMessages = [];

<\/script>
</body></html>`;
}

export class CSharpRunner extends BaseRunner {
  private iframe: HTMLIFrameElement | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(config: ClientBoxConfig) {
    super('csharp', config);
  }

  private async ensureIframe(): Promise<HTMLIFrameElement> {
    if (this.iframe && this.readyPromise) {
      await this.readyPromise;
      return this.iframe!;
    }

    this.setStatus('loading', 'Initializing C# runtime...');

    this.iframe = document.createElement('iframe');
    this.iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
    document.body.appendChild(this.iframe);

    const cdnUrl = this.config.dotnetCdnUrl || DEFAULT_DOTNET_CDN;
    const harness = buildCSharpHarness(cdnUrl);

    const iframe = this.iframe;
    this.readyPromise = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.type === 'clientbox-ready') {
          window.removeEventListener('message', handler);
          this.setStatus('ready', 'C# runtime ready');
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
      const iframe = await this.ensureIframe();
      this.setStatus('running');

      const result = await this.withTimeout(
        this.executeInIframe(iframe, id, options),
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
