import { useMemo, useState } from "react";
import { JournalHero } from "@/components/apex/journal/JournalHero";
import {
  JournalFilterBar,
  type JournalFilter,
} from "@/components/apex/journal/JournalFilterBar";
import { JournalCard } from "@/components/apex/journal/JournalCard";
import { useJournalEntries } from "@/hooks/apex/useJournalData";
import { DemoDataBanner } from "@/components/apex/DemoDataBanner";

export default function Journal() {
  const entries = useJournalEntries();
  const [filter, setFilter] = useState<JournalFilter>("ALL");

  const counts = useMemo(() => {
    const all = entries.data?.length ?? 0;
    const wins = entries.data?.filter((e) => e.outcome === "WIN").length ?? 0;
    const losses = entries.data?.filter((e) => e.outcome === "LOSS").length ?? 0;
    return { all, wins, losses };
  }, [entries.data]);

  const filtered = useMemo(() => {
    if (!entries.data) return [];
    if (filter === "ALL") return entries.data;
    return entries.data.filter((e) => e.outcome === filter);
  }, [entries.data, filter]);

  if (!entries.data) return null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <DemoDataBanner subject="journal entries" />
      <JournalHero entries={entries.data} />
      <JournalFilterBar filter={filter} onFilter={setFilter} counts={counts} />

      <div className="grid gap-4 md:grid-cols-2">
        {filtered.map((e) => (
          <JournalCard key={e.id} entry={e} />
        ))}
      </div>
    </div>
  );
}
