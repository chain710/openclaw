import { describe, expect, it } from "vitest";
import { clearHistoryEntriesIfEnabled, type HistoryEntry } from "./history.js";

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
    clearHistoryEntriesIfEnabled({
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

  it("should truncate history to limit when no specific count is provided", () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const historyKey = "test-room";
    const limit = 2;

    historyMap.set(historyKey, [
      { role: "user", content: "1", timestamp: Date.now() },
      { role: "assistant", content: "2", timestamp: Date.now() },
      { role: "user", content: "3", timestamp: Date.now() },
    ]);

    clearHistoryEntriesIfEnabled({
      historyMap,
      historyKey,
      limit,
    });

    // Should keep the last 2 entries
    const finalEntries = historyMap.get(historyKey);
    expect(finalEntries).toHaveLength(2);
    expect(finalEntries?.[0].content).toBe("2");
    expect(finalEntries?.[1].content).toBe("3");
  });
});
