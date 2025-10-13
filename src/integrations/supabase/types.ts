export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      account_metrics: {
        Row: {
          created_at: string
          daily_pnl: number
          daily_pnl_r: number
          date: string
          id: string
          losses_today: number
          open_positions_count: number
          risk_heat: number
          spread_percentile: number
          total_equity: number
          updated_at: string
          user_id: string
          wins_today: number
        }
        Insert: {
          created_at?: string
          daily_pnl?: number
          daily_pnl_r?: number
          date?: string
          id?: string
          losses_today?: number
          open_positions_count?: number
          risk_heat?: number
          spread_percentile?: number
          total_equity?: number
          updated_at?: string
          user_id: string
          wins_today?: number
        }
        Update: {
          created_at?: string
          daily_pnl?: number
          daily_pnl_r?: number
          date?: string
          id?: string
          losses_today?: number
          open_positions_count?: number
          risk_heat?: number
          spread_percentile?: number
          total_equity?: number
          updated_at?: string
          user_id?: string
          wins_today?: number
        }
        Relationships: []
      }
      bot_states: {
        Row: {
          created_at: string
          id: string
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          state: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      positions: {
        Row: {
          created_at: string
          current_price: number
          entry_price: number
          id: string
          meta_prob: number | null
          pnl: number
          pnl_r: number
          risk_progress: number
          side: string
          size: number
          status: string
          stop_loss: number
          strategy: string
          symbol: string
          take_profit: number
          time_closed: string | null
          time_opened: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_price: number
          entry_price: number
          id?: string
          meta_prob?: number | null
          pnl?: number
          pnl_r?: number
          risk_progress?: number
          side: string
          size: number
          status?: string
          stop_loss: number
          strategy: string
          symbol: string
          take_profit: number
          time_closed?: string | null
          time_opened?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_price?: number
          entry_price?: number
          id?: string
          meta_prob?: number | null
          pnl?: number
          pnl_r?: number
          risk_progress?: number
          side?: string
          size?: number
          status?: string
          stop_loss?: number
          strategy?: string
          symbol?: string
          take_profit?: number
          time_closed?: string | null
          time_opened?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      risk_settings: {
        Row: {
          atr_burst_multiplier: number
          created_at: string
          daily_stop_r: number
          id: string
          kill_switch_enabled: boolean
          max_heat: number
          per_trade_risk: number
          spread_threshold: number
          updated_at: string
          user_id: string
        }
        Insert: {
          atr_burst_multiplier?: number
          created_at?: string
          daily_stop_r?: number
          id?: string
          kill_switch_enabled?: boolean
          max_heat?: number
          per_trade_risk?: number
          spread_threshold?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          atr_burst_multiplier?: number
          created_at?: string
          daily_stop_r?: number
          id?: string
          kill_switch_enabled?: boolean
          max_heat?: number
          per_trade_risk?: number
          spread_threshold?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      strategy_signals: {
        Row: {
          avg_r: number | null
          created_at: string
          enabled: boolean
          id: string
          name: string
          params: Json
          updated_at: string
          user_id: string
          win_rate: number | null
        }
        Insert: {
          avg_r?: number | null
          created_at?: string
          enabled?: boolean
          id?: string
          name: string
          params?: Json
          updated_at?: string
          user_id: string
          win_rate?: number | null
        }
        Update: {
          avg_r?: number | null
          created_at?: string
          enabled?: boolean
          id?: string
          name?: string
          params?: Json
          updated_at?: string
          user_id?: string
          win_rate?: number | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
