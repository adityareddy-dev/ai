import type { UIMessage } from 'ai';
import type { Chat } from './chat.react';

/**
 * Client-side vitals for a single chat response, measured from the moment the
 * request is submitted until the stream ends.
 */
export type ChatVitals = {
  /**
   * The id of the chat.
   */
  chatId: string;

  /**
   * How the response ended.
   */
  status: 'ready' | 'error';

  /**
   * Time in ms from submit until the first visible text was painted
   * (anchored to the next animation frame after the first text chunk).
   * `undefined` if no text arrived.
   */
  timeToFirstVisibleTokenMs: number | undefined;

  /**
   * Visible text updates per second, measured from the first to the last
   * text update. `undefined` if fewer than two updates arrived.
   */
  tokenUpdatesPerSecond: number | undefined;

  /**
   * Gaps between text updates that exceeded the stall threshold.
   */
  stalls: {
    count: number;
    totalMs: number;
    maxMs: number;
  };

  /**
   * Long animation frames that occurred while the response was active.
   * All zero when the browser does not support them.
   */
  longAnimationFrames: {
    count: number;
    totalDurationMs: number;
    maxDurationMs: number;
  };
};

export type ChatVitalsOptions = {
  /**
   * Called once per response, when the stream has ended.
   */
  onReport: (vitals: ChatVitals) => void;

  /**
   * Gap in ms between text updates that counts as a stall.
   * Default is 1000.
   */
  stallThresholdMs?: number;
};

const DEFAULT_STALL_THRESHOLD_MS = 1000;

function now(): number {
  try {
    if (
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
    ) {
      return performance.now();
    }
  } catch {
    // fall through
  }
  return Date.now();
}

function getTextLength(message: UIMessage | undefined): number {
  if (message == null || message.role !== 'assistant') {
    return 0;
  }

  let length = 0;
  for (const part of message.parts) {
    if (
      (part.type === 'text' || part.type === 'reasoning') &&
      typeof part.text === 'string'
    ) {
      length += part.text.length;
    }
  }
  return length;
}

type Run = {
  startedAt: number;
  messageId: string | undefined;
  textLength: number;
  firstUpdateAt: number | undefined;
  lastUpdateAt: number | undefined;
  updates: number;
  visibleAt: number | undefined;
  frameHandle: number | undefined;
  stalls: number;
  stallTotalMs: number;
  stallMaxMs: number;
  loafCount: number;
  loafTotalMs: number;
  loafMaxMs: number;
  observer: PerformanceObserver | undefined;
};

function safely(fn: () => void) {
  try {
    fn();
  } catch {
    // vitals must never affect the caller's path
  }
}

/**
 * Observes a chat and reports vitals for each response. Returns a function
 * that stops observing. Never throws.
 */
export function observeChatVitals<UI_MESSAGE extends UIMessage>({
  chat,
  getOptions,
}: {
  chat: Chat<UI_MESSAGE>;
  getOptions: () => ChatVitalsOptions | undefined;
}): () => void {
  let run: Run | undefined;

  const stopRun = () => {
    const current = run;
    run = undefined;
    if (current == null) {
      return undefined;
    }

    safely(() => {
      if (
        current.frameHandle !== undefined &&
        typeof cancelAnimationFrame === 'function'
      ) {
        cancelAnimationFrame(current.frameHandle);
      }
    });

    safely(() => {
      if (current.observer != null) {
        for (const entry of current.observer.takeRecords()) {
          recordFrame(current, entry.duration);
        }
        current.observer.disconnect();
      }
    });

    return current;
  };

  const startRun = () => {
    stopRun();

    const current: Run = {
      startedAt: now(),
      messageId: undefined,
      textLength: 0,
      firstUpdateAt: undefined,
      lastUpdateAt: undefined,
      updates: 0,
      visibleAt: undefined,
      frameHandle: undefined,
      stalls: 0,
      stallTotalMs: 0,
      stallMaxMs: 0,
      loafCount: 0,
      loafTotalMs: 0,
      loafMaxMs: 0,
      observer: undefined,
    };
    run = current;

    safely(() => {
      if (
        typeof PerformanceObserver !== 'undefined' &&
        PerformanceObserver.supportedEntryTypes?.includes(
          'long-animation-frame',
        )
      ) {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            recordFrame(current, entry.duration);
          }
        });
        observer.observe({ type: 'long-animation-frame' });
        current.observer = observer;
      }
    });
  };

  const onMessages = () =>
    safely(() => {
      const current = run;
      if (current == null || chat.status !== 'streaming') {
        return;
      }

      const lastMessage = chat.messages[chat.messages.length - 1];
      if (lastMessage?.role !== 'assistant') {
        return;
      }

      if (lastMessage.id !== current.messageId) {
        current.messageId = lastMessage.id;
        current.textLength = 0;
      }

      const textLength = getTextLength(lastMessage);
      if (textLength <= current.textLength) {
        return;
      }
      current.textLength = textLength;

      const at = now();
      const thresholdMs =
        getOptions()?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;

      if (current.lastUpdateAt !== undefined) {
        const gap = at - current.lastUpdateAt;
        if (gap > thresholdMs) {
          current.stalls += 1;
          current.stallTotalMs += gap;
          current.stallMaxMs = Math.max(current.stallMaxMs, gap);
        }
      }

      current.updates += 1;
      current.lastUpdateAt = at;

      if (current.firstUpdateAt === undefined) {
        current.firstUpdateAt = at;

        if (typeof requestAnimationFrame === 'function') {
          current.frameHandle = requestAnimationFrame(() => {
            current.frameHandle = undefined;
            current.visibleAt = now();
          });
        } else {
          current.visibleAt = at;
        }
      }
    });

  const onStatus = () =>
    safely(() => {
      const status = chat.status;

      if (status === 'submitted') {
        if (getOptions() != null) {
          startRun();
        }
        return;
      }

      if (status === 'streaming') {
        if (run == null && getOptions() != null) {
          startRun();
        }
        return;
      }

      const finished = stopRun();
      const options = getOptions();
      if (finished == null || options == null) {
        return;
      }

      const visibleAt = finished.visibleAt ?? finished.firstUpdateAt;
      const spanMs =
        finished.firstUpdateAt !== undefined &&
        finished.lastUpdateAt !== undefined
          ? finished.lastUpdateAt - finished.firstUpdateAt
          : 0;

      const vitals: ChatVitals = {
        chatId: chat.id,
        status: status === 'error' ? 'error' : 'ready',
        timeToFirstVisibleTokenMs:
          visibleAt !== undefined ? visibleAt - finished.startedAt : undefined,
        tokenUpdatesPerSecond:
          finished.updates >= 2 && spanMs > 0
            ? ((finished.updates - 1) * 1000) / spanMs
            : undefined,
        stalls: {
          count: finished.stalls,
          totalMs: finished.stallTotalMs,
          maxMs: finished.stallMaxMs,
        },
        longAnimationFrames: {
          count: finished.loafCount,
          totalDurationMs: finished.loafTotalMs,
          maxDurationMs: finished.loafMaxMs,
        },
      };

      options.onReport(vitals);
    });

  const unsubscribes = [
    chat['~registerStatusCallback'](onStatus),
    chat['~registerMessagesCallback'](onMessages),
  ];

  // a response may already be in flight when observing starts
  onStatus();

  return () => {
    stopRun();
    unsubscribes.forEach(unsubscribe => unsubscribe());
  };
}

function recordFrame(run: Run, duration: number) {
  run.loafCount += 1;
  run.loafTotalMs += duration;
  run.loafMaxMs = Math.max(run.loafMaxMs, duration);
}
