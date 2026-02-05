import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { z } from "zod";
import { FIXED_USER_ID, useUserId } from "@/contexts/AuthContext";
import { invokeFunction } from "@/services/supabaseFunctions";

export const journalEntrySchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200, "Title must be less than 200 characters"),
  note: z.string().trim().max(5000, "Note must be less than 5000 characters").optional(),
  position_id: z.string().uuid().optional(),
  order_id: z.string().uuid().optional(),
  signal_id: z.string().uuid().optional(),
  attachments: z.array(z.string()).optional(),
});

export type JournalEntryInput = z.infer<typeof journalEntrySchema>;

export interface JournalEntry {
  id: string;
  user_id: string;
  title: string;
  note: string | null;
  position_id: string | null;
  order_id: string | null;
  signal_id: string | null;
  attachments: string[] | null;
  created_at: string;
}

export const useJournalEntries = (filters?: {
  search?: string;
  positionId?: string;
  dateFrom?: string;
  dateTo?: string;
}) => {
  const userId = useUserId();

  return useQuery({
    queryKey: ["journal-entries", userId, filters],
    queryFn: async () => {
      let query = supabase
        .from("journal_entries")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (filters?.search) {
        query = query.or(`title.ilike.%${filters.search}%,note.ilike.%${filters.search}%`);
      }

      if (filters?.positionId) {
        query = query.eq("position_id", filters.positionId);
      }

      if (filters?.dateFrom) {
        query = query.gte("created_at", filters.dateFrom);
      }

      if (filters?.dateTo) {
        query = query.lte("created_at", filters.dateTo);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data as JournalEntry[];
    },
  });
};

export const useCreateJournalEntry = () => {
  const queryClient = useQueryClient();
  const userId = useUserId();

  return useMutation({
    mutationFn: async (input: JournalEntryInput) => {
      // Validate input
      const validated = journalEntrySchema.parse(input);

      const result = await invokeFunction<
        {
          action: "create";
          user_id: string;
          title: string;
          note?: string;
          position_id?: string;
          order_id?: string;
          signal_id?: string;
          attachments?: string[];
        },
        { ok: boolean; id: string }
      >("journal-entry", {
        action: "create",
        user_id: FIXED_USER_ID,
        ...validated,
      });

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries", userId] });
      toast({
        title: "Entry Created",
        description: "Journal entry has been saved",
      });
    },
    onError: (error) => {
      toast({
        title: "Failed to Create Entry",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });
};

export const useUpdateJournalEntry = () => {
  const queryClient = useQueryClient();
  const userId = useUserId();

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: Partial<JournalEntryInput> }) => {
      // Validate input
      const validated = journalEntrySchema.partial().parse(input);

      const result = await invokeFunction<
        {
          action: "update";
          id: string;
          user_id: string;
          title?: string;
          note?: string | null;
          position_id?: string;
          order_id?: string;
          signal_id?: string;
          attachments?: string[];
        },
        { ok: boolean; id: string }
      >("journal-entry", {
        action: "update",
        id,
        user_id: FIXED_USER_ID,
        ...validated,
      });

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries", userId] });
      toast({
        title: "Entry Updated",
        description: "Journal entry has been saved",
      });
    },
    onError: (error) => {
      toast({
        title: "Failed to Update Entry",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });
};

export const useDeleteJournalEntry = () => {
  const queryClient = useQueryClient();
  const userId = useUserId();

  return useMutation({
    mutationFn: async (id: string) => {
      await invokeFunction<
        { action: "delete"; id: string; user_id: string },
        { ok: boolean; id: string }
      >("journal-entry", {
        action: "delete",
        id,
        user_id: FIXED_USER_ID,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries", userId] });
      toast({
        title: "Entry Deleted",
        description: "Journal entry has been removed",
      });
    },
    onError: (error) => {
      toast({
        title: "Failed to Delete Entry",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });
};
