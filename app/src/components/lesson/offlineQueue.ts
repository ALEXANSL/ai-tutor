"use client";

/**
 * BUG-007 fix: an answer given while the network is down is queued on the
 * device (IndexedDB) and resent automatically once the connection returns,
 * using the same `idempotencyKey` the server already de-duplicates on
 * (`step_attempts.idempotency_key`, US-6.5 КП-2, NFR-RES-1). Never throws —
 * a broken/unavailable IndexedDB (private mode, disabled storage) degrades
 * to "no queue" rather than breaking the lesson.
 */
export interface QueuedAnswer {
  idempotencyKey: string;
  sessionId: string;
  stepId: string;
  channel: "choice" | "text" | "voice" | "photo";
  answer: unknown;
  latencyMs: number | null;
  queuedAt: number;
}

const DB_NAME = "ai-tutor-lesson-offline";
const STORE = "pending-answers";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "idempotencyKey" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function enqueueAnswer(entry: QueuedAnswer): Promise<void> {
  await withStore("readwrite", (store) => store.put(entry));
}

export async function dequeueAnswer(idempotencyKey: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(idempotencyKey));
}

/** Oldest first, so a resend preserves the order the child actually answered in. */
export async function listQueuedAnswers(): Promise<QueuedAnswer[]> {
  const all = await withStore<QueuedAnswer[]>("readonly", (store) => store.getAll() as unknown as IDBRequest<QueuedAnswer[]>);
  return (all ?? []).sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * Pure resend logic, unit-tested without touching IndexedDB (BUG-007): sends
 * queued answers oldest-first with the *same* `idempotencyKey` they were
 * queued under (safe by construction — `step_attempts.idempotency_key` is
 * unique), and stops at the first failure so entries are never sent out of
 * order (the network is most likely still down).
 */
export async function resendQueued(
  entries: QueuedAnswer[],
  send: (entry: QueuedAnswer) => Promise<void>,
): Promise<{ sent: QueuedAnswer[]; failedAt: number | null }> {
  const sent: QueuedAnswer[] = [];
  for (let i = 0; i < entries.length; i++) {
    try {
      await send(entries[i]!);
      sent.push(entries[i]!);
    } catch {
      return { sent, failedAt: i };
    }
  }
  return { sent, failedAt: null };
}
