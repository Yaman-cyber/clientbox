export const NODE_WORKER_SOURCE = /* js */ `
'use strict';

self.onmessage = function(e) {
  var msg = e.data;
  if (msg.type !== 'run') return;

  var files = msg.files;
  var entryPoint = msg.entryPoint;
  var stdout = [];
  var stderr = [];
  var exitCode = 0;
  var error = null;

  function normalizePath(from, to) {
    if (to.startsWith('/')) return to;
    var parts = from.split('/');
    parts.pop();
    var toParts = to.split('/');
    for (var i = 0; i < toParts.length; i++) {
      if (toParts[i] === '..') parts.pop();
      else if (toParts[i] !== '.' && toParts[i] !== '') parts.push(toParts[i]);
    }
    return parts.join('/') || '/';
  }

  function resolveModule(requestPath, fromPath) {
    var resolved = normalizePath(fromPath, requestPath);
    if (files[resolved] !== undefined) return resolved;
    if (files[resolved + '.js'] !== undefined) return resolved + '.js';
    if (files[resolved + '.ts'] !== undefined) return resolved + '.ts';
    if (files[resolved + '.tsx'] !== undefined) return resolved + '.tsx';
    if (files[resolved + '.mjs'] !== undefined) return resolved + '.mjs';
    if (files[resolved + '/index.js'] !== undefined) return resolved + '/index.js';
    if (files[resolved + '/index.ts'] !== undefined) return resolved + '/index.ts';
    return null;
  }

  var moduleCache = {};

  function createRequire(currentPath) {
    return function require(request) {
      var resolvedPath = resolveModule(request, currentPath);
      if (!resolvedPath) {
        throw new Error("Cannot find module '" + request + "' from '" + currentPath + "'");
      }
      if (moduleCache[resolvedPath]) return moduleCache[resolvedPath].exports;

      var moduleObj = { exports: {} };
      moduleCache[resolvedPath] = moduleObj;
      var code = files[resolvedPath];
      if (isTS(resolvedPath)) code = stripTS(code);

      var wrappedFn = new Function(
        'module', 'exports', 'require', '__filename', '__dirname', 'console',
        code
      );
      wrappedFn(
        moduleObj,
        moduleObj.exports,
        createRequire(resolvedPath),
        resolvedPath,
        resolvedPath.substring(0, resolvedPath.lastIndexOf('/')),
        fakeConsole
      );
      return moduleObj.exports;
    };
  }

  var fakeConsole = {
    log: function()   { stdout.push(argsToString(arguments)); },
    info: function()  { stdout.push(argsToString(arguments)); },
    warn: function()  { stderr.push(argsToString(arguments)); },
    error: function() { stderr.push(argsToString(arguments)); },
    debug: function() { stdout.push(argsToString(arguments)); },
    dir: function(o)  { stdout.push(typeof o === 'object' ? JSON.stringify(o, null, 2) : String(o)); },
    clear: function() {},
    time: function() {},
    timeEnd: function() {},
    timeLog: function() {},
    trace: function() { stdout.push(new Error().stack || 'Trace'); },
    assert: function(cond) {
      if (!cond) {
        var msg = arguments.length > 1
          ? argsToString(Array.prototype.slice.call(arguments, 1))
          : 'Assertion failed';
        stderr.push(msg);
      }
    },
    table: function(data) { stdout.push(JSON.stringify(data, null, 2)); }
  };

  function isTS(path) {
    return path.endsWith('.ts') || path.endsWith('.tsx');
  }

  function stripTS(code) {
    // Remove interface/type declarations (full blocks and single lines)
    code = code.replace(/^\\s*(?:export\\s+)?interface\\s+\\w+[^{]*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}/gm, '');
    code = code.replace(/^\\s*(?:export\\s+)?type\\s+\\w+\\s*=[^;]+;/gm, '');
    code = code.replace(/^\\s*(?:export\\s+)?type\\s+\\w+\\s*=\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}/gm, '');

    // Remove enum declarations, replace with frozen object
    code = code.replace(/(?:export\\s+)?(?:const\\s+)?enum\\s+(\\w+)\\s*\\{([^}]*)\\}/g, function(_, name, body) {
      var members = body.split(',').filter(function(m) { return m.trim(); });
      var obj = {};
      var autoVal = 0;
      var entries = members.map(function(m) {
        var parts = m.trim().split('=');
        var key = parts[0].trim();
        if (!key) return '';
        var val;
        if (parts.length > 1) {
          val = parts[1].trim();
          var num = Number(val);
          if (!isNaN(num)) { autoVal = num + 1; val = String(num); }
        } else {
          val = String(autoVal);
          autoVal++;
        }
        return JSON.stringify(key) + ': ' + val;
      }).filter(function(e) { return e; });
      return 'var ' + name + ' = Object.freeze({' + entries.join(', ') + '});';
    });

    // Remove type imports: import type { ... } from '...'
    code = code.replace(/import\\s+type\\s+\\{[^}]*\\}\\s+from\\s+['\"][^'\"]+['\"];?/g, '');

    // Remove type-only parts from mixed imports: import { type Foo, Bar } -> import { Bar }
    code = code.replace(/,\\s*type\\s+\\w+/g, '');
    code = code.replace(/type\\s+\\w+\\s*,\\s*/g, '');

    // Remove type annotations (colon + type) before = ; , ) ] } =>
    // Handles generics, arrays, unions, intersections, and custom types
    code = code.replace(/:\\s*(?:[A-Za-z_$][\\w$]*(?:<[^>]*>)?(?:\\[\\])*)(?:\\s*[|&]\\s*(?:[A-Za-z_$][\\w$]*(?:<[^>]*>)?(?:\\[\\])*))*(?=\\s*[=;,)\\]}>])/g, '');

    // Remove function/arrow return types: ): string { -> ) { and ): string => -> ) =>
    code = code.replace(/\\)\\s*:\\s*(?:[A-Za-z_$][\\w$]*(?:<[^>]*>)?(?:\\[\\])*)(?:\\s*[|&]\\s*(?:[A-Za-z_$][\\w$]*(?:<[^>]*>)?(?:\\[\\])*))*(?=\\s*[{=])/g, ')');

    // Remove angle-bracket type params: foo<string>( -> foo(
    code = code.replace(/(\\w+)<[^>]+>\\s*\\(/g, '$1(');

    // Remove 'as Type' casts
    code = code.replace(/\\s+as\\s+(?:const|string|number|boolean|any|unknown|\\w+(?:<[^>]+>)?(?:\\[\\])*)/g, '');

    // Remove non-null assertions: x! -> x
    code = code.replace(/(\\w+)!/g, '$1');

    // Remove access modifiers: public/private/protected/readonly
    code = code.replace(/\\b(public|private|protected|readonly)\\s+/g, '');

    // abstract class -> class
    code = code.replace(/\\babstract\\s+class\\b/g, 'class');

    // Remove implements clauses
    code = code.replace(/\\bimplements\\s+[\\w,\\s<>]+(?=\\s*\\{)/g, '');

    // Remove declare statements
    code = code.replace(/^\\s*declare\\s+.+$/gm, '');

    // Remove angle-bracket type assertions: <Type>expr -> expr
    code = code.replace(/<(?:string|number|boolean|any|unknown|\\w+)>(?=\\w)/g, '');

    return code;
  }

  function argsToString(args) {
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

  try {
    var entryCode = files[entryPoint];
    if (entryCode === undefined) {
      throw new Error("Entry point not found: " + entryPoint);
    }
    if (isTS(entryPoint)) entryCode = stripTS(entryCode);

    var isESM = entryCode.includes('import ') || entryCode.includes('export ');

    if (isESM) {
      var transformed = entryCode;
      transformed = transformed.replace(
        /import\\s+(?:\\{([^}]+)\\}|([\\w$]+))\\s+from\\s+['"]([\\.][^'"]+)['"]/g,
        function(_, named, def, specifier) {
          var varName = def || '__imp_' + Math.random().toString(36).slice(2, 6);
          var req = 'var ' + varName + ' = require("' + specifier + '");';
          if (named) {
            var names = named.split(',').map(function(n) { return n.trim(); });
            var destructured = names.map(function(n) {
              var parts = n.split(/\\s+as\\s+/);
              return 'var ' + (parts[1] || parts[0]).trim() + ' = ' + varName + '["' + parts[0].trim() + '"];';
            }).join('\\n');
            return req + '\\n' + destructured;
          }
          return req;
        }
      );

      transformed = transformed.replace(
        /export\\s+default\\s+/g, 'module.exports = '
      );
      transformed = transformed.replace(
        /export\\s+(?:const|let|var|function|class)\\s+(\\w+)/g,
        function(match, name) {
          return match.replace(/^export\\s+/, '') + '; exports.' + name + ' = ' + name;
        }
      );
      entryCode = transformed;
    }

    var wrapFn = new Function(
      'module', 'exports', 'require', '__filename', '__dirname', 'console',
      entryCode
    );
    var mod = { exports: {} };
    moduleCache[entryPoint] = mod;
    wrapFn(
      mod,
      mod.exports,
      createRequire(entryPoint),
      entryPoint,
      entryPoint.substring(0, entryPoint.lastIndexOf('/')),
      fakeConsole
    );
  } catch(err) {
    exitCode = 1;
    error = err.message || String(err);
    stderr.push(err.stack || err.message || String(err));
  }

  self.postMessage({
    id: msg.id,
    type: exitCode === 0 ? 'result' : 'error',
    stdout: stdout.join('\\n'),
    stderr: stderr.join('\\n'),
    error: error,
    exitCode: exitCode
  });
};
`;
