import { SignalInput } from './signal-router';

export interface ISignalQueue {
  enqueue(signal: SignalInput): Promise<SignalInput>;
  size(): number;
}

export class DefaultSignalQueue implements ISignalQueue {
  async enqueue(signal: SignalInput): Promise<SignalInput> {
    return signal;
  }
  size(): number { return 0; }
}
