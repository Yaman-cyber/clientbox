export const PYTHON_WORKER_SOURCE = /* js */ `
'use strict';

var pyodide = null;
var pyodideReady = false;
var pyodideUrl = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';

// Shared-buffer layout for synchronous input from the main thread.
//   ctrl[0]: status (0 = waiting, 1 = data ready, 2 = EOF)
//   ctrl[1]: byte length of data payload
//   data starts at byte offset CTRL_BYTES
var CTRL_INTS = 2;
var CTRL_BYTES = CTRL_INTS * 4;

self.onmessage = async function(e) {
  var msg = e.data;

  if (msg.type === 'init') {
    if (msg.pyodideCdnUrl) pyodideUrl = msg.pyodideCdnUrl;
    try {
      importScripts(pyodideUrl + 'pyodide.js');
      pyodide = await loadPyodide({ indexURL: pyodideUrl });
      pyodideReady = true;
      self.postMessage({ type: 'ready' });
    } catch(err) {
      self.postMessage({ type: 'init-error', error: err.message || String(err) });
    }
    return;
  }

  if (msg.type !== 'run') return;

  if (!pyodideReady) {
    self.postMessage({
      id: msg.id,
      type: 'error',
      stdout: '',
      stderr: 'Pyodide runtime not loaded',
      error: 'Pyodide runtime not loaded',
      exitCode: 1
    });
    return;
  }

  var id = msg.id;
  var stdoutBuf = '';
  var stderrBuf = '';
  var exitCode = 0;
  var error = null;
  var decoder = new TextDecoder();
  var encoder = new TextEncoder();

  function emitStdout(text) {
    stdoutBuf += text;
    self.postMessage({ id: id, type: 'stdout', chunk: text });
  }
  function emitStderr(text) {
    stderrBuf += text;
    self.postMessage({ id: id, type: 'stderr', chunk: text });
  }

  // Stream output one chunk at a time so prompts without trailing newlines
  // are flushed before input() blocks.
  pyodide.setStdout({
    write: function(buf) {
      emitStdout(decoder.decode(buf, { stream: true }));
      return buf.length;
    }
  });
  pyodide.setStderr({
    write: function(buf) {
      emitStderr(decoder.decode(buf, { stream: true }));
      return buf.length;
    }
  });

  // Pre-supplied stdin lines are consumed first.
  var stdinLines = msg.stdin ? msg.stdin.split('\\n') : [];
  // Trailing empty element from split when input ends with newline is harmless.
  var stdinIndex = 0;

  var sab = msg.sab || null;
  var ctrl = sab ? new Int32Array(sab, 0, CTRL_INTS) : null;
  var dataView = sab ? new Uint8Array(sab, CTRL_BYTES) : null;

  // Pyodide invokes stdin synchronously; when we run out of pre-supplied lines
  // we block the worker on Atomics.wait while the main thread fetches input.
  pyodide.setStdin({
    stdin: function() {
      if (stdinIndex < stdinLines.length) {
        var line = stdinLines[stdinIndex++];
        // Last element from split('\\n') is '' when input ended with '\\n' — treat as EOF only if also the last.
        if (line === '' && stdinIndex === stdinLines.length) return null;
        return line + '\\n';
      }
      if (!sab) {
        // No way to request more input — signal EOF.
        return null;
      }
      Atomics.store(ctrl, 0, 0);
      Atomics.store(ctrl, 1, 0);
      self.postMessage({ id: id, type: 'input-request' });
      Atomics.wait(ctrl, 0, 0);
      var status = Atomics.load(ctrl, 0);
      if (status === 2) return null;
      var len = Atomics.load(ctrl, 1);
      if (len <= 0) return '\\n';
      var bytes = dataView.slice(0, len);
      var text = new TextDecoder().decode(bytes);
      if (text.charAt(text.length - 1) !== '\\n') text += '\\n';
      return text;
    }
  });

  try {
    var files = msg.files;
    var entryPoint = msg.entryPoint;

    var keys = Object.keys(files);
    for (var i = 0; i < keys.length; i++) {
      var filePath = keys[i];
      var content = files[filePath];
      var parts = filePath.split('/').filter(function(p) { return p; });
      if (parts.length > 1) {
        var dir = '/' + parts.slice(0, -1).join('/');
        try { pyodide.FS.mkdirTree(dir); } catch(e) {}
      }
      pyodide.FS.writeFile(filePath, content);
    }

    var entryDir = entryPoint.substring(0, entryPoint.lastIndexOf('/'));
    if (entryDir) {
      pyodide.runPython('import sys; sys.path.insert(0, "' + entryDir + '")');
    }
    pyodide.runPython('import sys; sys.path.insert(0, "/")');

    var code = files[entryPoint];
    if (code === undefined) {
      throw new Error('Entry point not found: ' + entryPoint);
    }

    await pyodide.runPythonAsync(code);
  } catch(err) {
    exitCode = 1;
    var errMsg = '';
    if (err && err.message) {
      errMsg = err.message;
    } else {
      errMsg = String(err);
    }
    error = errMsg;
    emitStderr(errMsg);
  }

  for (var j = 0; j < keys.length; j++) {
    try { pyodide.FS.unlink(keys[j]); } catch(e) {}
  }

  self.postMessage({
    id: id,
    type: exitCode === 0 ? 'result' : 'error',
    stdout: stdoutBuf,
    stderr: stderrBuf,
    error: error,
    exitCode: exitCode
  });
};
`;
