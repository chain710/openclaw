import { describe, expect, it } from "vitest";
import { clearHistoryEntriesIfEnabled, trimHistoryEntries, type HistoryEntry } from "./history.js";

describe("History Logic - Concurrency and Clearing", () => {
  it("should preserve concurrent new messages by using snapshot count during clearing", () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const historyKey = "test-room";
    const limit = 10;

    // 1. Initial state: User A sends a message. Agent starts processing.
    // The handler captures the snapshot count at this moment.
    historyMap.set(historyKey, [
      { role: "user", content: "Message from User A", timestamp: Date.now() },
    ]);
    const snapshotCount = historyMap.get(historyKey)?.length ?? 0;
    expect(snapshotCount).toBe(1);

    // 2. While Agent A is running, User B sends a message.
    // It gets appended to the same history key.
    const currentEntries = historyMap.get(historyKey) || [];
    historyMap.set(historyKey, [
      ...currentEntries,
      { role: "user", content: "Message from User B", timestamp: Date.now() },
    ]);
    expect(historyMap.get(historyKey)).toHaveLength(2);

    // 3. Agent A finishes and triggers clearing with the snapshot count.
    trimHistoryEntries({
      historyMap,
      historyKey,
      limit,
      count: snapshotCount,
    });

    // VERIFICATION:
    // - User A's message (which was part of the snapshot) should be cleared.
    // - User B's message (which arrived later) must be preserved.
    const finalEntries = historyMap.get(historyKey);
    expect(finalEntries).toHaveLength(1);
    expect(finalEntries?.[0].content).toBe("Message from User B");
  });

  it("should clear ALL history when no specific count is provided (regression test)", () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const historyKey = "test-room";
    const limit = 10;

    historyMap.set(historyKey, [{ role: "user", content: "1", timestamp: Date.now() }]);

    clearHistoryEntriesIfEnabled({
      historyMap,
      historyKey,
      limit,
    });

    const finalEntries = historyMap.get(historyKey);
    expect(finalEntries).toHaveLength(0);
  });

  it("should skip clearing when limit is 0 (history disabled)", () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const historyKey = "test-room";
    const limit = 0; // History disabled: no-op

    historyMap.set(historyKey, [
      { role: "user", content: "entry", timestamp: Date.now() } as unknown as HistoryEntry,
    ]);

    clearHistoryEntriesIfEnabled({
      historyMap,
      historyKey,
      limit,
    });

    // limit=0 means history is disabled; function should be a no-op
    const finalEntries = historyMap.get(historyKey);
    expect(finalEntries).toHaveLength(1);
  });

  it("should preserve concurrent messages AND assistant's own reply while clearing the triggering message (Matrix history logic)", () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const historyKey = "test-room";
    const limit = 10;

    // 1. Inbound message A arrives and is recorded
    historyMap.set(historyKey, [
      { role: "user", content: "Trigger Message A", timestamp: 1000 } as unknown as HistoryEntry,
    ]);

    // 2. Snapshot is taken (includes Message A)
    const snapshotCount = historyMap.get(historyKey)?.length ?? 0;
    expect(snapshotCount).toBe(1);

    // 3. Concurrent message B arrives while Agent is thinking
    const current = historyMap.get(historyKey) || [];
    historyMap.set(historyKey, [
      ...current,
      { role: "user", content: "Concurrent Message B", timestamp: 2000 } as unknown as HistoryEntry,
    ]);

    // 4. Agent finishes generating response and records ITS OWN reply
    const afterResponse = historyMap.get(historyKey) || [];
    historyMap.set(historyKey, [
      ...afterResponse,
      { role: "assistant", content: "Agent Reply", timestamp: 3000 } as unknown as HistoryEntry,
    ]);

    // 5. Matrix handler clears history using the snapshotCount AND assistantCount
    trimHistoryEntries({
      historyMap,
      historyKey,
      limit,
      count: snapshotCount,
      assistantCount: 1,
    });

    // VERIFICATION:
    // - Trigger Message A (index 0) should be gone.
    // - Concurrent Message B (index 1) should stay.
    // - Agent Reply (index 2) should ALSO be gone (it's part of the current turn).
    const finalEntries = historyMap.get(historyKey);
    expect(finalEntries).toHaveLength(1);
    expect(finalEntries?.[0].content).toBe("Concurrent Message B");
  });
});
