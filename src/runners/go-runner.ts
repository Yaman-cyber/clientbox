import { BaseRunner } from './base.js';
import type { ClientBoxConfig, RunOptions, RunResult } from '../types.js';

function buildGoHarness(): string {
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
    var result = executeGo(allCode);
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

function executeGo(code) {
  var stdout = [];
  var stderr = [];
  var error = null;

  try {
    var jsCode = transpileGoToJS(code);
    var fn = new Function('fmt', 'math', 'strings', 'strconv', jsCode);
    fn(
      buildFmt(stdout),
      buildMathPkg(),
      buildStringsPkg(),
      buildStrconvPkg()
    );
  } catch(e) {
    error = e.message || String(e);
    stderr.push(error);
  }

  return { stdout: stdout, stderr: stderr, error: error };
}

function buildFmt(stdout) {
  function sprintArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      parts.push(args[i] === null ? '<nil>' :
                 args[i] === undefined ? '<nil>' : String(args[i]));
    }
    return parts.join(' ');
  }

  function sprintfFmt(format, args) {
    var idx = 0;
    return format.replace(/%([vdsftqxobec%])/g, function(_, spec) {
      if (spec === '%') return '%';
      if (idx >= args.length) return '%' + spec;
      var val = args[idx++];
      switch(spec) {
        case 'd': return String(parseInt(val));
        case 'f': return String(parseFloat(val));
        case 's': return String(val);
        case 'q': return '"' + String(val) + '"';
        case 't': return String(!!val);
        case 'v': default: return String(val);
      }
    });
  }

  return {
    Println: function() {
      stdout.push(sprintArgs(Array.from(arguments)));
    },
    Print: function() {
      stdout.push(sprintArgs(Array.from(arguments)));
    },
    Printf: function(format) {
      var args = Array.prototype.slice.call(arguments, 1);
      stdout.push(sprintfFmt(format, args));
    },
    Sprintf: function(format) {
      var args = Array.prototype.slice.call(arguments, 1);
      return sprintfFmt(format, args);
    },
    Sprint: function() {
      return sprintArgs(Array.from(arguments));
    }
  };
}

function buildMathPkg() {
  return {
    Abs: function(x) { return Math.abs(x); },
    Ceil: function(x) { return Math.ceil(x); },
    Floor: function(x) { return Math.floor(x); },
    Max: function(a, b) { return Math.max(a, b); },
    Min: function(a, b) { return Math.min(a, b); },
    Pow: function(b, e) { return Math.pow(b, e); },
    Sqrt: function(x) { return Math.sqrt(x); },
    Round: function(x) { return Math.round(x); },
    Log: function(x) { return Math.log(x); },
    Log2: function(x) { return Math.log2(x); },
    Log10: function(x) { return Math.log10(x); },
    Pi: Math.PI,
    E: Math.E,
    Inf: function(sign) { return sign >= 0 ? Infinity : -Infinity; },
    IsNaN: function(x) { return isNaN(x); },
    NaN: function() { return NaN; }
  };
}

function buildStringsPkg() {
  return {
    Contains: function(s, sub) { return s.indexOf(sub) !== -1; },
    HasPrefix: function(s, prefix) { return s.indexOf(prefix) === 0; },
    HasSuffix: function(s, suffix) { return s.indexOf(suffix, s.length - suffix.length) !== -1; },
    Index: function(s, sub) { return s.indexOf(sub); },
    Join: function(arr, sep) { return arr.join(sep); },
    Split: function(s, sep) { return s.split(sep); },
    Replace: function(s, old, nw, n) { if (n < 0) return s.split(old).join(nw); var r = s; for (var i = 0; i < n; i++) r = r.replace(old, nw); return r; },
    ReplaceAll: function(s, old, nw) { return s.split(old).join(nw); },
    ToLower: function(s) { return s.toLowerCase(); },
    ToUpper: function(s) { return s.toUpperCase(); },
    TrimSpace: function(s) { return s.trim(); },
    Trim: function(s, cutset) { var re = new RegExp('^[' + cutset + ']+|[' + cutset + ']+$', 'g'); return s.replace(re, ''); },
    Repeat: function(s, n) { return s.repeat(n); },
    Count: function(s, sub) { if (!sub) return s.length + 1; var c = 0; var i = 0; while ((i = s.indexOf(sub, i)) !== -1) { c++; i += sub.length; } return c; },
    Title: function(s) { return s.replace(/\\b\\w/g, function(c) { return c.toUpperCase(); }); },
    EqualFold: function(a, b) { return a.toLowerCase() === b.toLowerCase(); }
  };
}

function buildStrconvPkg() {
  return {
    Itoa: function(n) { return String(n); },
    Atoi: function(s) { var n = parseInt(s, 10); if (isNaN(n)) throw new Error('strconv.Atoi: parsing "' + s + '": invalid syntax'); return n; },
    FormatFloat: function(f, fmt, prec) { return prec >= 0 ? f.toFixed(prec) : String(f); },
    FormatInt: function(n, base) { return n.toString(base); },
    FormatBool: function(b) { return String(!!b); },
    ParseInt: function(s, base) { var n = parseInt(s, base || 10); if (isNaN(n)) throw new Error('strconv.ParseInt: parsing "' + s + '"'); return n; },
    ParseFloat: function(s) { var n = parseFloat(s); if (isNaN(n)) throw new Error('strconv.ParseFloat: parsing "' + s + '"'); return n; }
  };
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

function transpileGoToJS(code) {
  var lines = code.split('\\n');
  var filtered = [];
  var imports = {};

  // Parse package and import declarations
  var inImportBlock = false;
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (trimmed.startsWith('package ')) continue;

    if (trimmed === 'import (') { inImportBlock = true; continue; }
    if (inImportBlock) {
      if (trimmed === ')') { inImportBlock = false; continue; }
      var imp = trimmed.replace(/['"]/g, '').trim();
      if (imp) imports[imp] = true;
      continue;
    }
    if (trimmed.startsWith('import ')) {
      var singleImp = trimmed.replace(/^import\\s+/, '').replace(/['"]/g, '').trim();
      if (singleImp) imports[singleImp] = true;
      continue;
    }

    filtered.push(lines[i]);
  }
  var body = filtered.join('\\n');

  // Find all function declarations
  var funcRe = /func\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:\\(([^)]*)\\)|([\\w*\\[\\]]*(?:\\s*,\\s*[\\w*\\[\\]]*)*))?\\s*\\{/g;

  var functions = [];
  var mainBody = null;
  var match;

  while ((match = funcRe.exec(body)) !== null) {
    var name = match[1];
    var params = match[2];
    var openBrace = body.indexOf('{', match.index + match[0].length - 1);
    var block = extractBraceBlock(body, openBrace);

    if (name === 'main') {
      mainBody = block.body;
    } else {
      var jsParams = parseGoParams(params);
      functions.push({
        name: name,
        params: jsParams,
        body: block.body
      });
    }
  }

  var output = [];

  // Built-in helpers
  output.push('function len(a) { if (typeof a === "string") return a.length; if (Array.isArray(a)) return a.length; if (a && typeof a === "object") return Object.keys(a).length; return 0; }');
  output.push('function cap(a) { return Array.isArray(a) ? a.length : 0; }');
  output.push('function append(slice) { var args = Array.prototype.slice.call(arguments, 1); return slice.concat(args); }');
  output.push('function make(type, len, cap) { if (type === "slice" || type === "[]") { var a = []; for (var i = 0; i < (len||0); i++) a.push(type === "map" ? {} : 0); return a; } if (type === "map") return {}; return []; }');
  output.push('function panic(msg) { throw new Error("panic: " + msg); }');
  output.push('function string(v) { if (typeof v === "number") return String.fromCharCode(v); return String(v); }');
  output.push('function int(v) { return parseInt(v, 10) || 0; }');
  output.push('function float64(v) { return parseFloat(v) || 0; }');
  output.push('');

  // Emit helper functions
  for (var m = 0; m < functions.length; m++) {
    output.push('function ' + functions[m].name + '(' + functions[m].params + ') {');
    output.push(transformGoBody(functions[m].body));
    output.push('}');
    output.push('');
  }

  // Emit main body
  if (mainBody !== null) {
    output.push(transformGoBody(mainBody));
  } else {
    output.push(transformGoBody(body));
  }

  return output.join('\\n');
}

function parseGoParams(params) {
  if (!params || !params.trim()) return '';
  var parts = params.split(',');
  var names = [];
  for (var i = 0; i < parts.length; i++) {
    var tokens = parts[i].trim().split(/\\s+/);
    if (tokens.length >= 1 && tokens[0]) {
      names.push(tokens[0]);
    }
  }
  return names.join(', ');
}

function transformGoBody(body) {
  var result = body;

  // Slice literals: []type{...} -> [...]  (must replace matching braces)
  result = result.replace(/\\[\\]\\w+\\{([^}]*)\\}/g, '[$1]');

  // Map literals: map[K]V{...} -> {...}
  result = result.replace(/map\\[[^\\]]+\\]\\w+\\{/g, '{');

  // for range with index and value (before := transform)
  result = result.replace(
    /for\\s+(\\w+)\\s*,\\s*(\\w+)\\s*:=\\s*range\\s+(\\w+)\\s*\\{/g,
    'for (var [$1, $2] of $3.entries()) {'
  );
  // for _, v := range items {
  result = result.replace(
    /for\\s+_\\s*,\\s*(\\w+)\\s*:=\\s*range\\s+(\\w+)\\s*\\{/g,
    'for (var $1 of $2) {'
  );
  // for i := range items {
  result = result.replace(
    /for\\s+(\\w+)\\s*:=\\s*range\\s+(\\w+)\\s*\\{/g,
    'for (var $1 of $2.keys()) {'
  );

  // for init; cond; post { -> for (init; cond; post) {
  // Handle := in init part
  result = result.replace(
    /for\\s+([^;{]+);\\s*([^;{]+);\\s*([^{]+)\\{/g,
    function(_, init, cond, post) {
      init = init.replace(/(\\w+)\\s*:=/, 'var $1 =');
      return 'for (' + init.trim() + '; ' + cond.trim() + '; ' + post.trim() + ') {';
    }
  );

  // bare for { -> while (true) {
  result = result.replace(/^(\\s*)for\\s*\\{/gm, '$1while (true) {');

  // for condition { -> while (condition) {  (skip already-transformed for-loops)
  result = result.replace(/\\bfor\\s+([^{;(]+)\\s*\\{/g, function(_, cond) {
    var c = cond.trim();
    if (!c || c === 'true') return 'while (true) {';
    return 'while (' + c + ') {';
  });

  // := short variable declarations -> var (after for-range transforms)
  result = result.replace(/(\\w+(?:\\s*,\\s*\\w+)*)\\s*:=\\s*/g, function(_, vars) {
    var names = vars.split(',').map(function(v) { return v.trim(); });
    if (names.length === 1) return 'var ' + names[0] + ' = ';
    return 'var [' + names.join(', ') + '] = ';
  });

  // var declarations with types: var x int = 5 -> var x = 5
  result = result.replace(/\\bvar\\s+(\\w+)\\s+(?:int(?:8|16|32|64)?|uint(?:8|16|32|64)?|float(?:32|64)|string|bool|byte|rune|interface\\{\\})\\s*=/g, 'var $1 =');

  // Uninitialized typed vars
  result = result.replace(/\\bvar\\s+(\\w+)\\s+(?:int(?:8|16|32|64)?|uint(?:8|16|32|64)?|float(?:32|64)|byte|rune)\\s*$/gm, 'var $1 = 0');
  result = result.replace(/\\bvar\\s+(\\w+)\\s+string\\s*$/gm, 'var $1 = ""');
  result = result.replace(/\\bvar\\s+(\\w+)\\s+bool\\s*$/gm, 'var $1 = false');

  // } else { and } else if ... { -- already valid JS

  // if/else if without parens: add parens around condition
  result = result.replace(/\\bif\\s+([^({][^{]*)\\{/g, function(_, cond) {
    return 'if (' + cond.trim() + ') {';
  });
  result = result.replace(/}\\s*else\\s+if\\s+([^({][^{]*)\\{/g, function(_, cond) {
    return '} else if (' + cond.trim() + ') {';
  });

  // switch
  result = result.replace(/\\bswitch\\s+([^{]+)\\{/g, function(_, expr) {
    var e = expr.trim();
    if (!e) return 'switch (true) {';
    return 'switch (' + e + ') {';
  });

  // nil -> null
  result = result.replace(/\\bnil\\b/g, 'null');

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

export class GoRunner extends BaseRunner {
  private iframe: HTMLIFrameElement | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(config: ClientBoxConfig) {
    super('go', config);
  }

  private async ensureIframe(): Promise<HTMLIFrameElement> {
    if (this.iframe && this.readyPromise) {
      await this.readyPromise;
      return this.iframe!;
    }

    this.setStatus('loading', 'Initializing Go runtime...');

    this.iframe = document.createElement('iframe');
    this.iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;';
    document.body.appendChild(this.iframe);

    const harness = buildGoHarness();

    const iframe = this.iframe;
    this.readyPromise = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.type === 'clientbox-ready') {
          window.removeEventListener('message', handler);
          this.setStatus('ready', 'Go runtime ready');
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
