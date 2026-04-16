export const PYTHON_WORKER_SOURCE = /* js */ `
'use strict';

var pyodide = null;
var pyodideReady = false;
var pyodideUrl = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';

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

  var stdout = [];
  var stderr = [];
  var exitCode = 0;
  var error = null;

  pyodide.setStdout({ batched: function(line) { stdout.push(line); } });
  pyodide.setStderr({ batched: function(line) { stderr.push(line); } });

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
    stderr.push(errMsg);
  }

  for (var j = 0; j < keys.length; j++) {
    try { pyodide.FS.unlink(keys[j]); } catch(e) {}
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
