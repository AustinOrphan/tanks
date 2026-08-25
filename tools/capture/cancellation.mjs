const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

export class CaptureCancelledError extends Error {
  constructor(signalName, message = `capture cancelled by ${signalName}`) {
    super(message);
    this.name = 'CaptureCancelledError';
    this.code = 'CAPTURE_CANCELLED';
    this.signalName = signalName;
    this.exitCode = signalExitCode(signalName);
  }
}

export function signalExitCode(signalName) {
  return SIGNAL_EXIT_CODES[signalName] ?? 1;
}

export function cancellationError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new CaptureCancelledError('ABORT', 'capture cancelled');
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw cancellationError(signal);
}

/** Follow wrapped `cause` chains so adapters can add context without hiding cancellation. */
export function findCancellation(error) {
  const seen = new Set();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current.code === 'CAPTURE_CANCELLED') return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}
