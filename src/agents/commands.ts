import type { RpcSocket } from './rpc';
import type { ApprovalDecision } from './types';

// The orchestration commands Luma sends. The TV and the voice service share
// them, so both speak to T3 Code the same way.

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID needs a secure context; plain-HTTP previews don't have one.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type Command = { type: string; threadId: string } & Record<string, unknown>;

export const dispatchCommand = (socket: RpcSocket, command: Command) =>
  socket.request('orchestration.dispatchCommand', { ...command, commandId: uuid() });

export const decideCommand = (
  threadId: string,
  requestId: string,
  decision: ApprovalDecision,
): Command => ({ type: 'runtime-request.respond', threadId, requestId, decision });

export const answerCommand = (
  threadId: string,
  requestId: string,
  answers: Record<string, string | string[]>,
): Command => ({ type: 'runtime-request.respond', threadId, requestId, answers });

/** The server decides whether a message steers or queues behind an active run. */
export const messageCommand = (threadId: string, text: string): Command => ({
  type: 'message.dispatch',
  createdBy: 'user',
  creationSource: 'web',
  threadId,
  messageId: uuid(),
  text,
  attachments: [],
  deliveryIntent: 'auto',
  dispatchMode: { type: 'start_immediately' },
});

export const stopCommand = (threadId: string): Command => ({ type: 'thread.stop', threadId });
