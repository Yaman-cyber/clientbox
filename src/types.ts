export type Language = 'node' | 'python' | 'web' | 'csharp' | 'java' | 'php' | 'dart' | 'go';

export interface ClientBoxConfig {
  /** Default execution timeout in ms (default: 30000) */
  timeout?: number;
  /** Override the Pyodide CDN base URL */
  pyodideCdnUrl?: string;
  /** Override the CheerpJ loader URL */
  cheerpjCdnUrl?: string;
  /** Override the .NET WASM CDN base URL */
  dotnetCdnUrl?: string;
  /** Called when a runner's status changes (loading runtime, executing, etc.) */
  onStatusChange?: (event: StatusEvent) => void;
}

export interface RunOptions {
  /** Map of virtual file paths to their string contents */
  files: Record<string, string>;
  /** The file path to execute as the entry point (e.g. "/index.js") */
  entryPoint: string;
  /** Optional stdin string to feed to the program */
  stdin?: string;
  /** Override execution timeout for this run (ms) */
  timeout?: number;
}

export interface RunResult {
  /** Captured standard output */
  stdout: string;
  /** Captured standard error */
  stderr: string;
  /** Error message if execution failed, null on success */
  error: string | null;
  /** 0 on success, non-zero on failure */
  exitCode: number;
  /** Wall-clock execution time in ms */
  duration: number;
}

export type RunnerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'running'
  | 'destroyed';

export interface StatusEvent {
  language: Language;
  status: RunnerStatus;
  message?: string;
}

export interface WorkerRequest {
  id: string;
  type: 'run';
  files: Record<string, string>;
  entryPoint: string;
  stdin?: string;
}

export interface WorkerResponse {
  id: string;
  type: 'result' | 'error';
  stdout: string;
  stderr: string;
  error: string | null;
  exitCode: number;
}

export interface IframeMessage {
  type: 'clientbox-run' | 'clientbox-result' | 'clientbox-ready' | 'clientbox-console';
  id?: string;
  files?: Record<string, string>;
  entryPoint?: string;
  stdin?: string;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  exitCode?: number;
  method?: string;
  args?: unknown[];
}
