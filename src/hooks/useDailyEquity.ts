// Hook for daily equity data for equity curve visualization
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const MOCK_USER_ID = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';

export interface DailyEquityRow {
  id: string;
  user_id: string;
  date: string;
  starting_equity: number;
  ending_equity: number;
  high_water_mark: number;
  drawdown_pct: number;
  realized_pnl: number;
  unrealized_pnl: number;
  fees_total: number;
  trades_count: number;
  wins: number;
  losses: number;
  created_at: string;
}

export function useDailyEquity(days: number = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  return useQuery({
    queryKey: ['daily-equity', days],
    queryFn: async (): Promise<DailyEquityRow[]> => {
      // Query the raw table via REST since it's a new table not in types yet
      try {
        const response = await fetch(
          `https://gdrdaajvutmewgxbjurk.supabase.co/rest/v1/daily_equity?user_id=eq.${MOCK_USER_ID}&date=gte.${startDate.toISOString().split('T')[0]}&order=date.asc`,
          {
            headers: {
              'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I',
              'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I',
            }
          }
        );
        if (!response.ok) return [];
        return await response.json();
      } catch {
        return [];
      }
    },
    refetchInterval: 60000, // Refresh every minute
  });
}
