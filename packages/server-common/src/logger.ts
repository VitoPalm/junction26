/**
 * Minimal structured JSON logger (one object per line on stdout).
 *
 * Log metadata, never content: no tokens, keys, raw documents, chat text or
 * state snapshots. Pass IDs (requestId, jobId, projectId, revisionId) instead.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(
  options: { level?: LogLevel; bindings?: LogFields; sink?: LogSink } = {},
): Logger {
  const min = ORDER[options.level ?? 'info'];
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? ((line) => process.stdout.write(line + '\n'));

  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    const record: LogFields = { time: new Date().toISOString(), level, msg, ...bindings };
    if (fields) for (const [k, v] of Object.entries(fields)) record[k] = serialize(v);
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (more) => createLogger({ level: options.level, bindings: { ...bindings, ...more }, sink }),
  };
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** A logger that drops everything; for tests. */
export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} });
