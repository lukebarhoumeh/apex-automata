import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { z } from "zod";

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
  return useQuery({
    queryKey: ["journal-entries", filters],
    queryFn: async () => {
      let query = supabase
        .from("journal_entries")
        .select("*")
        .eq("user_id", "b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f") // Fixed USER_ID
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

  return useMutation({
    mutationFn: async (input: JournalEntryInput) => {
      // Validate input
      const validated = journalEntrySchema.parse(input);

      // Use fixed USER_ID for single-user MVP
      const user = { id: 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f' };

      const { data, error } = await supabase
        .from("journal_entries")
        .insert({
          user_id: user.id,
          ...validated,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
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

  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: Partial<JournalEntryInput> }) => {
      // Validate input
      const validated = journalEntrySchema.partial().parse(input);

      const { data, error } = await supabase
        .from("journal_entries")
        .update(validated)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
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

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("journal_entries").delete().eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-entries"] });
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
