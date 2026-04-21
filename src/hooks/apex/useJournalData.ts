import { useQuery } from "@tanstack/react-query";
import type { JournalEntry } from "@/types/journal";
import { JOURNAL_SEED } from "./mock/seed-data";

export function useJournalEntries() {
  return useQuery<readonly JournalEntry[]>({
    queryKey: ["apex", "journal-entries"],
    queryFn: () => Promise.resolve(JOURNAL_SEED),
    staleTime: 60_000,
  });
}
