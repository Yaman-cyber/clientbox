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

  function esmToCjs(code) {
    if (code.indexOf('import ') === -1 && code.indexOf('export ') === -1) return code;
    var t = code;

    // import { a, b } from './mod'  or  import { a as x } from './mod'
    t = t.replace(
      /import\\s+\\{([^}]+)\\}\\s+from\\s+['\"]([^'\"]+)['\"];?/g,
      function(_, named, spec) {
        var tmp = '__imp_' + Math.random().toString(36).slice(2, 7);
        var req = 'var ' + tmp + ' = require("' + spec + '");';
        var names = named.split(',').map(function(n) { return n.trim(); }).filter(function(n) { return n; });
        var decls = names.map(function(n) {
          var parts = n.split(/\\s+as\\s+/);
          return 'var ' + (parts[1] || parts[0]).trim() + ' = ' + tmp + '["' + parts[0].trim() + '"];';
        }).join('\\n');
        return req + '\\n' + decls;
      }
    );

    // import * as name from './mod'
    t = t.replace(
      /import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['\"]([^'\"]+)['\"];?/g,
      'var $1 = require("$2");'
    );

    // import defaultName from './mod'
    t = t.replace(
      /import\\s+([\\w$]+)\\s+from\\s+['\"]([^'\"]+)['\"];?/g,
      function(_, def, spec) {
        var tmp = '__imp_' + Math.random().toString(36).slice(2, 7);
        return 'var ' + tmp + ' = require("' + spec + '"); var ' + def + ' = ' + tmp + '.__esModule ? ' + tmp + '.default : ' + tmp + ';';
      }
    );

    // import './mod' (side-effect)
    t = t.replace(
      /import\\s+['\"]([^'\"]+)['\"];?/g,
      'require("$1");'
    );

    // export default expr
    t = t.replace(
      /export\\s+default\\s+/g,
      'module.exports.__esModule = true; module.exports.default = '
    );

    // export { name1, name2 }  and  export { name1 as alias }
    t = t.replace(
      /export\\s+\\{([^}]+)\\};?/g,
      function(_, names) {
        return names.split(',').map(function(n) {
          var parts = n.trim().split(/\\s+as\\s+/);
          var local = parts[0].trim();
          var exported = (parts[1] || parts[0]).trim();
          return 'exports["' + exported + '"] = ' + local + ';';
        }).join('\\n');
      }
    );

    // export const/let/var/function/class name -> strip export, collect name
    var exportedNames = [];
    t = t.replace(
      /export\\s+(const|let|var|function|class)\\s+(\\w+)/g,
      function(_, keyword, name) {
        exportedNames.push(name);
        return keyword + ' ' + name;
      }
    );
    for (var ei = 0; ei < exportedNames.length; ei++) {
      t += '\\nexports["' + exportedNames[ei] + '"] = ' + exportedNames[ei] + ';';
    }

    return t;
  }

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
      code = esmToCjs(code);

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

    // Remove type-only parts from mixed imports
    code = code.replace(/,\\s*type\\s+\\w+/g, '');
    code = code.replace(/type\\s+\\w+\\s*,\\s*/g, '');

    // Remove 'as Type' casts
    code = code.replace(/\\s+as\\s+(?:const|string|number|boolean|any|unknown|\\w+(?:<[^>]+>)?(?:\\[\\])*)/g, '');

    // Remove non-null assertions: x! -> x
    code = code.replace(/(\\w+)!/g, '$1');

    // Remove access modifiers
    code = code.replace(/\\b(public|private|protected|readonly)\\s+/g, '');

    // abstract class -> class
    code = code.replace(/\\babstract\\s+class\\b/g, 'class');

    // Remove implements clauses
    code = code.replace(/\\bimplements\\s+[\\w,\\s<>]+(?=\\s*\\{)/g, '');

    // Remove declare statements
    code = code.replace(/^\\s*declare\\s+.+$/gm, '');

    // Remove angle-bracket type assertions: <Type>expr -> expr
    code = code.replace(/<(?:string|number|boolean|any|unknown|\\w+)>(?=\\w)/g, '');

    // Remove generic type params from function calls/declarations: foo<T>( -> foo(
    code = code.replace(/(\\w+)\\s*<[^>]+>\\s*\\(/g, '$1(');
    // Remove generic declarations: function foo<T, U> -> function foo
    code = code.replace(/(function\\s+\\w+)\\s*<[^>]+>/g, '$1');
    // Remove class generic params: class Foo<T> -> class Foo
    code = code.replace(/(class\\s+\\w+)\\s*<[^>]+>/g, '$1');

    // Scanner-based type annotation removal for colon types
    // Handles complex types like (T | T[])[], Map<string, number>, etc.
    code = removeColonTypes(code);

    return code;
  }

  function removeColonTypes(src) {
    var result = '';
    var i = 0;
    var len = src.length;
    var BT = String.fromCharCode(96);
    while (i < len) {
      // Skip string literals
      if (src[i] === '"' || src[i] === "'" || src[i] === BT) {
        var q = src[i];
        result += src[i++];
        while (i < len && src[i] !== q) {
          if (src[i] === '\\\\') { result += src[i++]; if (i < len) result += src[i++]; continue; }
          if (q === BT && src[i] === '$' && src[i+1] === '{') {
            result += src[i++]; result += src[i++];
            var bd = 1;
            while (i < len && bd > 0) {
              if (src[i] === '{') bd++;
              else if (src[i] === '}') bd--;
              if (bd > 0) result += src[i];
              i++;
            }
            result += '}';
            continue;
          }
          result += src[i++];
        }
        if (i < len) result += src[i++];
        continue;
      }
      // Skip line comments
      if (src[i] === '/' && i + 1 < len && src[i+1] === '/') {
        while (i < len && src[i] !== '\\n') result += src[i++];
        continue;
      }
      // Skip block comments
      if (src[i] === '/' && i + 1 < len && src[i+1] === '*') {
        result += src[i++]; result += src[i++];
        while (i < len - 1 && !(src[i] === '*' && src[i+1] === '/')) result += src[i++];
        if (i < len) { result += src[i++]; result += src[i++]; }
        continue;
      }
      // Check for colon that could be a type annotation
      if (src[i] === ':') {
        // Look back: should be after identifier, ?, or )
        var bi = i - 1;
        while (bi >= 0 && (src[bi] === ' ' || src[bi] === '\\t')) bi--;
        var isAfterIdent = bi >= 0 && /[\\w$?)]/.test(src[bi]);
        // Look forward past whitespace
        var fi = i + 1;
        while (fi < len && (src[fi] === ' ' || src[fi] === '\\t')) fi++;
        // Check it looks like a type (starts with letter, (, [, {, or typeof)
        var looksLikeType = fi < len && /[A-Za-z_$(\\[{]/.test(src[fi]);
        if (isAfterIdent && looksLikeType) {
          // Check we're NOT inside an object literal { key: value }
          var inObject = false;
          var bd2 = 0;
          for (var k = bi; k >= 0; k--) {
            if (src[k] === '}') bd2++;
            else if (src[k] === '{') { bd2--; if (bd2 < 0) { inObject = true; break; } }
            else if (src[k] === ';' && bd2 === 0) break;
          }
          if (!inObject) {
            // Skip the type annotation by tracking bracket depth
            var dp = 0, db = 0, da = 0, dc = 0;
            var j = fi;
            while (j < len) {
              var c = src[j];
              if (c === '(') dp++;
              else if (c === ')') { if (dp === 0) break; dp--; }
              else if (c === '[') db++;
              else if (c === ']') { if (db === 0) break; db--; }
              else if (c === '<') da++;
              else if (c === '>') { if (da > 0) da--; else break; }
              else if (c === '{') { if (dp === 0 && db === 0 && da === 0) break; dc++; }
              else if (c === '}') { if (dc === 0) break; dc--; }
              else if ((c === '=' || c === ',' || c === ';') && dp === 0 && db === 0 && da === 0 && dc === 0) break;
              j++;
            }
            // For optional params (name?: Type), also remove the ? from result
            if (src[bi] === '?') {
              var ti = result.length - 1;
              while (ti >= 0 && (result[ti] === ' ' || result[ti] === '\\t')) ti--;
              if (ti >= 0 && result[ti] === '?') result = result.substring(0, ti);
            }
            // Skip colon and type, keep the terminator
            i = j;
            continue;
          }
        }
      }
      result += src[i++];
    }
    return result;
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
    entryCode = esmToCjs(entryCode);

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
