import type { HistoryEntry } from "./types.js";

export const DEFAULT_GROUP_HISTORY_LIMIT = 50;

export function recordPendingHistoryEntryIfEnabled(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  entry: HistoryEntry;
}): void {
  if (params.limit <= 0) {
    return;
  }
  const history = params.historyMap.get(params.historyKey) ?? [];
  history.push(params.entry);
  while (history.length > params.limit) {
    history.shift();
  }
  params.historyMap.set(params.historyKey, history);
}

export function buildPendingHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
}): string {
  if (params.limit <= 0) {
    return params.currentMessage;
  }
  const entries = params.historyMap.get(params.historyKey) ?? [];
  if (entries.length === 0) {
    return params.currentMessage;
  }
  const historyText = entries.map(params.formatEntry).join("\n");
  const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
  const CURRENT_MESSAGE_MARKER = "[Current Message]";
  return [HISTORY_CONTEXT_MARKER, historyText, "", CURRENT_MESSAGE_MARKER, params.currentMessage].join(
    "\n",
  );
}

export function clearHistoryEntriesIfEnabled(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
}): void {
  if (params.limit <= 0) {
    return;
  }
  params.historyMap.set(params.historyKey, []);
}

export function trimHistoryEntries(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  count: number;
  assistantCount?: number;
}): void {
  if (params.limit <= 0) {
    return;
  }
  const entries = params.historyMap.get(params.historyKey);
  if (entries && entries.length > 0) {
    let result = entries;
    if (params.count > 0) {
      result = result.slice(params.count);
    }
    if (params.assistantCount && params.assistantCount > 0) {
      result = result.slice(0, -params.assistantCount);
    }
    params.historyMap.set(params.historyKey, result);
  }
}
