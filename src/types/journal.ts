export type JournalOutcome = "WIN" | "LOSS";

export interface JournalEntry {
  id: string;
  sym: string;
  side: "LONG" | "SHORT";
  date: string;
  time: string;
  r: number;
  pnl: number;
  outcome: JournalOutcome;
  tags: readonly string[];
  entry: number;
  exit: number;
  stop: number;
  target: number;
  thesis: string;
  lessons: string;
  seed: number;
}
