import { useQuery } from "@tanstack/react-query";
import type { SettingsData } from "@/types/settings";
import { SETTINGS_SEED } from "./mock/seed-data";

export function useSettings() {
  return useQuery<SettingsData>({
    queryKey: ["apex", "settings"],
    queryFn: () => Promise.resolve(SETTINGS_SEED),
    staleTime: 60_000,
  });
}
