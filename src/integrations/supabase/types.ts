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
      alerts: {
        Row: {
          acked_at: string | null
          created_at: string
          data: Json | null
          id: string
          message: string | null
          severity: Database["public"]["Enums"]["alert_severity"]
          title: string
          user_id: string
        }
        Insert: {
          acked_at?: string | null
          created_at?: string
          data?: Json | null
          id?: string
          message?: string | null
          severity?: Database["public"]["Enums"]["alert_severity"]
          title: string
          user_id: string
        }
        Update: {
          acked_at?: string | null
          created_at?: string
          data?: Json | null
          id?: string
          message?: string | null
          severity?: Database["public"]["Enums"]["alert_severity"]
          title?: string
          user_id?: string
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
      daily_equity: {
        Row: {
          created_at: string | null
          daily_pnl: number | null
          date: string
          end_equity: number | null
          id: string
          start_equity: number
          user_id: string
        }
        Insert: {
          created_at?: string | null
          daily_pnl?: number | null
          date: string
          end_equity?: number | null
          id?: string
          start_equity: number
          user_id: string
        }
        Update: {
          created_at?: string | null
          daily_pnl?: number | null
          date?: string
          end_equity?: number | null
          id?: string
          start_equity?: number
          user_id?: string
        }
        Relationships: []
      }
      exchange_credentials: {
        Row: {
          api_key_encrypted: string | null
          api_key_iv: string | null
          api_key_tag: string | null
          api_passphrase_encrypted: string | null
          api_passphrase_iv: string | null
          api_passphrase_tag: string | null
          api_secret_encrypted: string | null
          api_secret_iv: string | null
          api_secret_tag: string | null
          created_at: string | null
          environment: string
          exchange: string
          id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          api_key_encrypted?: string | null
          api_key_iv?: string | null
          api_key_tag?: string | null
          api_passphrase_encrypted?: string | null
          api_passphrase_iv?: string | null
          api_passphrase_tag?: string | null
          api_secret_encrypted?: string | null
          api_secret_iv?: string | null
          api_secret_tag?: string | null
          created_at?: string | null
          environment?: string
          exchange: string
          id?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          api_key_encrypted?: string | null
          api_key_iv?: string | null
          api_key_tag?: string | null
          api_passphrase_encrypted?: string | null
          api_passphrase_iv?: string | null
          api_passphrase_tag?: string | null
          api_secret_encrypted?: string | null
          api_secret_iv?: string | null
          api_secret_tag?: string | null
          created_at?: string | null
          environment?: string
          exchange?: string
          id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      fills: {
        Row: {
          fee_amount: number | null
          fee_currency: string | null
          filled_at: string
          id: string
          maker: boolean | null
          order_id: string
          order_leg_id: string | null
          price: number
          quantity: number
          slippage_bps: number | null
          trade_id: string | null
          user_id: string
        }
        Insert: {
          fee_amount?: number | null
          fee_currency?: string | null
          filled_at: string
          id?: string
          maker?: boolean | null
          order_id: string
          order_leg_id?: string | null
          price: number
          quantity: number
          slippage_bps?: number | null
          trade_id?: string | null
          user_id: string
        }
        Update: {
          fee_amount?: number | null
          fee_currency?: string | null
          filled_at?: string
          id?: string
          maker?: boolean | null
          order_id?: string
          order_leg_id?: string | null
          price?: number
          quantity?: number
          slippage_bps?: number | null
          trade_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fills_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fills_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "v_recent_activity"
            referencedColumns: ["order_id"]
          },
          {
            foreignKeyName: "fills_order_leg_id_fkey"
            columns: ["order_leg_id"]
            isOneToOne: false
            referencedRelation: "order_legs"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entries: {
        Row: {
          attachments: string[] | null
          created_at: string
          id: string
          note: string | null
          order_id: string | null
          position_id: string | null
          signal_id: string | null
          title: string | null
          user_id: string
        }
        Insert: {
          attachments?: string[] | null
          created_at?: string
          id?: string
          note?: string | null
          order_id?: string | null
          position_id?: string | null
          signal_id?: string | null
          title?: string | null
          user_id: string
        }
        Update: {
          attachments?: string[] | null
          created_at?: string
          id?: string
          note?: string | null
          order_id?: string | null
          position_id?: string | null
          signal_id?: string | null
          title?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "v_recent_activity"
            referencedColumns: ["order_id"]
          },
          {
            foreignKeyName: "journal_entries_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "v_open_positions"
            referencedColumns: ["position_id"]
          },
          {
            foreignKeyName: "journal_entries_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics_intraday: {
        Row: {
          bucket_start: string
          created_at: string
          id: number
          metric: string
          symbol: string | null
          user_id: string
          value: number
        }
        Insert: {
          bucket_start: string
          created_at?: string
          id?: number
          metric: string
          symbol?: string | null
          user_id: string
          value: number
        }
        Update: {
          bucket_start?: string
          created_at?: string
          id?: number
          metric?: string
          symbol?: string | null
          user_id?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "metrics_intraday_symbol_fkey"
            columns: ["symbol"]
            isOneToOne: false
            referencedRelation: "symbols"
            referencedColumns: ["symbol"]
          },
        ]
      }
      models: {
        Row: {
          active: boolean
          created_at: string
          id: string
          input_schema: Json | null
          metrics: Json | null
          name: string
          path: string
          sha256: string | null
          user_id: string
          version: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          input_schema?: Json | null
          metrics?: Json | null
          name?: string
          path: string
          sha256?: string | null
          user_id: string
          version: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          input_schema?: Json | null
          metrics?: Json | null
          name?: string
          path?: string
          sha256?: string | null
          user_id?: string
          version?: string
        }
        Relationships: []
      }
      order_legs: {
        Row: {
          created_at: string
          external_order_id: string | null
          id: string
          maker: boolean | null
          order_id: string
          price: number | null
          quantity: number
          slippage_bps: number | null
          status: Database["public"]["Enums"]["order_status"]
          type: Database["public"]["Enums"]["order_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          external_order_id?: string | null
          id?: string
          maker?: boolean | null
          order_id: string
          price?: number | null
          quantity: number
          slippage_bps?: number | null
          status?: Database["public"]["Enums"]["order_status"]
          type: Database["public"]["Enums"]["order_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          external_order_id?: string | null
          id?: string
          maker?: boolean | null
          order_id?: string
          price?: number | null
          quantity?: number
          slippage_bps?: number | null
          status?: Database["public"]["Enums"]["order_status"]
          type?: Database["public"]["Enums"]["order_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_legs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_legs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "v_recent_activity"
            referencedColumns: ["order_id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          external_order_id: string | null
          id: string
          meta_prob: number | null
          post_only: boolean
          price: number | null
          quantity: number
          side: Database["public"]["Enums"]["order_side"]
          signal_id: string | null
          status: Database["public"]["Enums"]["order_status"]
          stop_price: number | null
          strategy: Database["public"]["Enums"]["strategy_name"]
          symbol: string
          time_in_force: string | null
          type: Database["public"]["Enums"]["order_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          external_order_id?: string | null
          id?: string
          meta_prob?: number | null
          post_only?: boolean
          price?: number | null
          quantity: number
          side: Database["public"]["Enums"]["order_side"]
          signal_id?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          stop_price?: number | null
          strategy: Database["public"]["Enums"]["strategy_name"]
          symbol: string
          time_in_force?: string | null
          type: Database["public"]["Enums"]["order_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          external_order_id?: string | null
          id?: string
          meta_prob?: number | null
          post_only?: boolean
          price?: number | null
          quantity?: number
          side?: Database["public"]["Enums"]["order_side"]
          signal_id?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          stop_price?: number | null
          strategy?: Database["public"]["Enums"]["strategy_name"]
          symbol?: string
          time_in_force?: string | null
          type?: Database["public"]["Enums"]["order_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_symbol_fkey"
            columns: ["symbol"]
            isOneToOne: false
            referencedRelation: "symbols"
            referencedColumns: ["symbol"]
          },
        ]
      }
      positions: {
        Row: {
          closed_at: string | null
          created_at: string
          entry_price: number
          exit_price: number | null
          exit_reason: Database["public"]["Enums"]["trade_exit_reason"] | null
          id: string
          opened_at: string
          qty_open: number
          realized_pnl_usd: number | null
          realized_r: number | null
          side: Database["public"]["Enums"]["position_side"]
          stop_price_at_entry: number
          strategy: Database["public"]["Enums"]["strategy_name"]
          symbol: string
          take_profit_price: number | null
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          entry_price: number
          exit_price?: number | null
          exit_reason?: Database["public"]["Enums"]["trade_exit_reason"] | null
          id?: string
          opened_at?: string
          qty_open: number
          realized_pnl_usd?: number | null
          realized_r?: number | null
          side: Database["public"]["Enums"]["position_side"]
          stop_price_at_entry: number
          strategy: Database["public"]["Enums"]["strategy_name"]
          symbol: string
          take_profit_price?: number | null
          user_id: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          entry_price?: number
          exit_price?: number | null
          exit_reason?: Database["public"]["Enums"]["trade_exit_reason"] | null
          id?: string
          opened_at?: string
          qty_open?: number
          realized_pnl_usd?: number | null
          realized_r?: number | null
          side?: Database["public"]["Enums"]["position_side"]
          stop_price_at_entry?: number
          strategy?: Database["public"]["Enums"]["strategy_name"]
          symbol?: string
          take_profit_price?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_symbol_fkey"
            columns: ["symbol"]
            isOneToOne: false
            referencedRelation: "symbols"
            referencedColumns: ["symbol"]
          },
        ]
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
      risk_events: {
        Row: {
          active: boolean
          cleared_at: string | null
          details: Json | null
          event_type: string
          id: string
          triggered_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          cleared_at?: string | null
          details?: Json | null
          event_type: string
          id?: string
          triggered_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          cleared_at?: string | null
          details?: Json | null
          event_type?: string
          id?: string
          triggered_at?: string
          user_id?: string
        }
        Relationships: []
      }
      risk_metrics: {
        Row: {
          consecutive_losses: number | null
          created_at: string | null
          daily_pnl: number | null
          error_rate: number | null
          exposure_usd: number | null
          id: string
          kill_switch_active: boolean | null
          max_drawdown: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          consecutive_losses?: number | null
          created_at?: string | null
          daily_pnl?: number | null
          error_rate?: number | null
          exposure_usd?: number | null
          id?: string
          kill_switch_active?: boolean | null
          max_drawdown?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          consecutive_losses?: number | null
          created_at?: string | null
          daily_pnl?: number | null
          error_rate?: number | null
          exposure_usd?: number | null
          id?: string
          kill_switch_active?: boolean | null
          max_drawdown?: number | null
          updated_at?: string | null
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
      signals: {
        Row: {
          allowed: boolean
          confidence: number
          created_at: string
          decided_at: string
          features: Json | null
          id: string
          meta_prob: number | null
          reason: string | null
          score: number
          side: Database["public"]["Enums"]["position_side"]
          strategy: Database["public"]["Enums"]["strategy_name"]
          symbol: string
          user_id: string
        }
        Insert: {
          allowed?: boolean
          confidence: number
          created_at?: string
          decided_at?: string
          features?: Json | null
          id?: string
          meta_prob?: number | null
          reason?: string | null
          score: number
          side: Database["public"]["Enums"]["position_side"]
          strategy: Database["public"]["Enums"]["strategy_name"]
          symbol: string
          user_id: string
        }
        Update: {
          allowed?: boolean
          confidence?: number
          created_at?: string
          decided_at?: string
          features?: Json | null
          id?: string
          meta_prob?: number | null
          reason?: string | null
          score?: number
          side?: Database["public"]["Enums"]["position_side"]
          strategy?: Database["public"]["Enums"]["strategy_name"]
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "signals_symbol_fkey"
            columns: ["symbol"]
            isOneToOne: false
            referencedRelation: "symbols"
            referencedColumns: ["symbol"]
          },
        ]
      }
      strategies: {
        Row: {
          created_at: string
          default_params: Json
          enabled: boolean
          id: string
          name: Database["public"]["Enums"]["strategy_name"]
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          default_params?: Json
          enabled?: boolean
          id?: string
          name: Database["public"]["Enums"]["strategy_name"]
          user_id: string
          version?: number
        }
        Update: {
          created_at?: string
          default_params?: Json
          enabled?: boolean
          id?: string
          name?: Database["public"]["Enums"]["strategy_name"]
          user_id?: string
          version?: number
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
          user_id: string | null
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
          user_id?: string | null
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
          user_id?: string | null
          win_rate?: number | null
        }
        Relationships: []
      }
      symbols: {
        Row: {
          active: boolean
          base_asset: string
          created_at: string
          id: string
          lot_size: number
          quote_asset: string
          symbol: string
          tick_size: number
        }
        Insert: {
          active?: boolean
          base_asset: string
          created_at?: string
          id?: string
          lot_size?: number
          quote_asset: string
          symbol: string
          tick_size?: number
        }
        Update: {
          active?: boolean
          base_asset?: string
          created_at?: string
          id?: string
          lot_size?: number
          quote_asset?: string
          symbol?: string
          tick_size?: number
        }
        Relationships: []
      }
      trade_log: {
        Row: {
          created_at: string | null
          duration_seconds: number | null
          entry_order_id: string | null
          entry_price: number
          entry_time: string
          exit_order_id: string | null
          exit_price: number | null
          exit_reason: string | null
          exit_time: string | null
          fees: number | null
          id: string
          max_adverse_excursion: number | null
          max_favorable_excursion: number | null
          outcome: string | null
          realized_pnl: number | null
          reason_code: string | null
          session_id: string
          side: string
          signal_id: string | null
          size: number
          slippage_bps: number | null
          strategy: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          duration_seconds?: number | null
          entry_order_id?: string | null
          entry_price: number
          entry_time: string
          exit_order_id?: string | null
          exit_price?: number | null
          exit_reason?: string | null
          exit_time?: string | null
          fees?: number | null
          id?: string
          max_adverse_excursion?: number | null
          max_favorable_excursion?: number | null
          outcome?: string | null
          realized_pnl?: number | null
          reason_code?: string | null
          session_id: string
          side: string
          signal_id?: string | null
          size: number
          slippage_bps?: number | null
          strategy?: string | null
          symbol: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          duration_seconds?: number | null
          entry_order_id?: string | null
          entry_price?: number
          entry_time?: string
          exit_order_id?: string | null
          exit_price?: number | null
          exit_reason?: string | null
          exit_time?: string | null
          fees?: number | null
          id?: string
          max_adverse_excursion?: number | null
          max_favorable_excursion?: number | null
          outcome?: string | null
          realized_pnl?: number | null
          reason_code?: string | null
          session_id?: string
          side?: string
          signal_id?: string | null
          size?: number
          slippage_bps?: number | null
          strategy?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      trade_outcomes: {
        Row: {
          adx: number | null
          atr_percent: number | null
          bb_width: number | null
          choppiness: number | null
          cold_streak_active: boolean | null
          created_at: string | null
          entry_price: number
          entry_time: string
          exit_price: number | null
          exit_reason: string | null
          exit_time: string | null
          fees: number | null
          hold_duration_seconds: number | null
          id: string
          indicators_snapshot: Json
          initial_risk: number | null
          max_adverse_excursion: number | null
          max_favorable_excursion: number | null
          meta_filter_score: number | null
          mtf_alignment: number | null
          outcome_label: string | null
          outcome_score: number | null
          pnl_percent: number | null
          position_multiplier: number | null
          position_size: number | null
          r_multiple: number | null
          realized_pnl: number | null
          regime: string
          regime_confidence: number | null
          session_id: string | null
          signal_direction: string
          signal_id: string
          signal_metadata: Json | null
          signal_strength: number
          slippage_bps: number | null
          strategy: string
          symbol: string
          trend_direction: string | null
          updated_at: string | null
          volume_ratio: number | null
        }
        Insert: {
          adx?: number | null
          atr_percent?: number | null
          bb_width?: number | null
          choppiness?: number | null
          cold_streak_active?: boolean | null
          created_at?: string | null
          entry_price: number
          entry_time: string
          exit_price?: number | null
          exit_reason?: string | null
          exit_time?: string | null
          fees?: number | null
          hold_duration_seconds?: number | null
          id?: string
          indicators_snapshot?: Json
          initial_risk?: number | null
          max_adverse_excursion?: number | null
          max_favorable_excursion?: number | null
          meta_filter_score?: number | null
          mtf_alignment?: number | null
          outcome_label?: string | null
          outcome_score?: number | null
          pnl_percent?: number | null
          position_multiplier?: number | null
          position_size?: number | null
          r_multiple?: number | null
          realized_pnl?: number | null
          regime: string
          regime_confidence?: number | null
          session_id?: string | null
          signal_direction: string
          signal_id: string
          signal_metadata?: Json | null
          signal_strength: number
          slippage_bps?: number | null
          strategy: string
          symbol: string
          trend_direction?: string | null
          updated_at?: string | null
          volume_ratio?: number | null
        }
        Update: {
          adx?: number | null
          atr_percent?: number | null
          bb_width?: number | null
          choppiness?: number | null
          cold_streak_active?: boolean | null
          created_at?: string | null
          entry_price?: number
          entry_time?: string
          exit_price?: number | null
          exit_reason?: string | null
          exit_time?: string | null
          fees?: number | null
          hold_duration_seconds?: number | null
          id?: string
          indicators_snapshot?: Json
          initial_risk?: number | null
          max_adverse_excursion?: number | null
          max_favorable_excursion?: number | null
          meta_filter_score?: number | null
          mtf_alignment?: number | null
          outcome_label?: string | null
          outcome_score?: number | null
          pnl_percent?: number | null
          position_multiplier?: number | null
          position_size?: number | null
          r_multiple?: number | null
          realized_pnl?: number | null
          regime?: string
          regime_confidence?: number | null
          session_id?: string | null
          signal_direction?: string
          signal_id?: string
          signal_metadata?: Json | null
          signal_strength?: number
          slippage_bps?: number | null
          strategy?: string
          symbol?: string
          trend_direction?: string | null
          updated_at?: string | null
          volume_ratio?: number | null
        }
        Relationships: []
      }
      trading_sessions: {
        Row: {
          created_at: string | null
          ended_at: string | null
          final_equity: number | null
          initial_equity: number | null
          mode: string
          session_id: string
          started_at: string | null
          total_pnl: number | null
          total_trades: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          ended_at?: string | null
          final_equity?: number | null
          initial_equity?: number | null
          mode: string
          session_id: string
          started_at?: string | null
          total_pnl?: number | null
          total_trades?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          ended_at?: string | null
          final_equity?: number | null
          initial_equity?: number | null
          mode?: string
          session_id?: string
          started_at?: string | null
          total_pnl?: number | null
          total_trades?: number | null
          updated_at?: string | null
          user_id?: string
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
      daily_trade_summary: {
        Row: {
          avg_duration_seconds: number | null
          avg_slippage_bps: number | null
          breakeven: number | null
          gross_loss: number | null
          gross_profit: number | null
          losses: number | null
          profit_factor: number | null
          total_pnl: number | null
          total_trades: number | null
          trade_date: string | null
          user_id: string | null
          win_rate: number | null
          wins: number | null
        }
        Relationships: []
      }
      ml_training_data: {
        Row: {
          adx: number | null
          atr_percent: number | null
          bb_lower: number | null
          bb_upper: number | null
          bb_width: number | null
          choppiness: number | null
          cold_streak_encoded: number | null
          ema21: number | null
          ema9: number | null
          entry_time: string | null
          hold_duration_seconds: number | null
          id: string | null
          macd: number | null
          macd_histogram: number | null
          macd_signal: number | null
          meta_filter_score: number | null
          mtf_alignment: number | null
          outcome_label: string | null
          outcome_score: number | null
          pnl_percent: number | null
          position_multiplier: number | null
          profitable_binary: number | null
          r_multiple: number | null
          regime: string | null
          regime_confidence: number | null
          rsi: number | null
          signal_direction: string | null
          signal_strength: number | null
          strategy: string | null
          symbol: string | null
          trend_direction_encoded: number | null
          volume_ratio: number | null
          vwap: number | null
        }
        Insert: {
          adx?: number | null
          atr_percent?: number | null
          bb_lower?: never
          bb_upper?: never
          bb_width?: number | null
          choppiness?: number | null
          cold_streak_encoded?: never
          ema21?: never
          ema9?: never
          entry_time?: string | null
          hold_duration_seconds?: number | null
          id?: string | null
          macd?: never
          macd_histogram?: never
          macd_signal?: never
          meta_filter_score?: number | null
          mtf_alignment?: number | null
          outcome_label?: string | null
          outcome_score?: number | null
          pnl_percent?: number | null
          position_multiplier?: number | null
          profitable_binary?: never
          r_multiple?: number | null
          regime?: string | null
          regime_confidence?: number | null
          rsi?: never
          signal_direction?: string | null
          signal_strength?: number | null
          strategy?: string | null
          symbol?: string | null
          trend_direction_encoded?: never
          volume_ratio?: number | null
          vwap?: never
        }
        Update: {
          adx?: number | null
          atr_percent?: number | null
          bb_lower?: never
          bb_upper?: never
          bb_width?: number | null
          choppiness?: number | null
          cold_streak_encoded?: never
          ema21?: never
          ema9?: never
          entry_time?: string | null
          hold_duration_seconds?: number | null
          id?: string | null
          macd?: never
          macd_histogram?: never
          macd_signal?: never
          meta_filter_score?: number | null
          mtf_alignment?: number | null
          outcome_label?: string | null
          outcome_score?: number | null
          pnl_percent?: number | null
          position_multiplier?: number | null
          profitable_binary?: never
          r_multiple?: number | null
          regime?: string | null
          regime_confidence?: number | null
          rsi?: never
          signal_direction?: string | null
          signal_strength?: number | null
          strategy?: string | null
          symbol?: string | null
          trend_direction_encoded?: never
          volume_ratio?: number | null
          vwap?: never
        }
        Relationships: []
      }
      strategy_regime_performance: {
        Row: {
          avg_hold_seconds: number | null
          avg_meta_score: number | null
          avg_pnl_percent: number | null
          avg_r_multiple: number | null
          avg_signal_strength: number | null
          losses: number | null
          regime: string | null
          strategy: string | null
          total_trades: number | null
          win_rate: number | null
          wins: number | null
        }
        Relationships: []
      }
      v_daily_r: {
        Row: {
          daily_r: number | null
          day: string | null
          user_id: string | null
        }
        Relationships: []
      }
      v_open_positions: {
        Row: {
          entry_price: number | null
          opened_at: string | null
          position_id: string | null
          qty_open: number | null
          side: Database["public"]["Enums"]["position_side"] | null
          stop_price_at_entry: number | null
          strategy: Database["public"]["Enums"]["strategy_name"] | null
          symbol: string | null
          take_profit_price: number | null
          user_id: string | null
        }
        Insert: {
          entry_price?: number | null
          opened_at?: string | null
          position_id?: string | null
          qty_open?: number | null
          side?: Database["public"]["Enums"]["position_side"] | null
          stop_price_at_entry?: number | null
          strategy?: Database["public"]["Enums"]["strategy_name"] | null
          symbol?: string | null
          take_profit_price?: number | null
          user_id?: string | null
        }
        Update: {
          entry_price?: number | null
          opened_at?: string | null
          position_id?: string | null
          qty_open?: number | null
          side?: Database["public"]["Enums"]["position_side"] | null
          stop_price_at_entry?: number | null
          strategy?: Database["public"]["Enums"]["strategy_name"] | null
          symbol?: string | null
          take_profit_price?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "positions_symbol_fkey"
            columns: ["symbol"]
            isOneToOne: false
            referencedRelation: "symbols"
            referencedColumns: ["symbol"]
          },
        ]
      }
      v_recent_activity: {
        Row: {
          created_at: string | null
          fill_count: number | null
          filled_qty: number | null
          order_id: string | null
          price: number | null
          quantity: number | null
          side: Database["public"]["Enums"]["order_side"] | null
          status: Database["public"]["Enums"]["order_status"] | null
          symbol: string | null
          type: Database["public"]["Enums"]["order_type"] | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_symbol_fkey"
            columns: ["symbol"]
            isOneToOne: false
            referencedRelation: "symbols"
            referencedColumns: ["symbol"]
          },
        ]
      }
      v_signal_funnel: {
        Row: {
          allowed: number | null
          hour: string | null
          rejected: number | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      upsert_account_metrics: {
        Args: { p_user_id: string }
        Returns: undefined
      }
    }
    Enums: {
      alert_severity: "info" | "warning" | "critical"
      app_role: "admin" | "moderator" | "user"
      order_side: "buy" | "sell"
      order_status:
        | "new"
        | "working"
        | "partially_filled"
        | "filled"
        | "canceled"
        | "rejected"
        | "expired"
      order_type:
        | "limit"
        | "market"
        | "ioc"
        | "twap_parent"
        | "twap_child"
        | "post_only"
        | "stop"
        | "take_profit"
      position_side: "long" | "short"
      strategy_name: "breakout" | "vwap_mr" | "obi_scalper" | "momentum"
      trade_exit_reason:
        | "take_profit"
        | "stop_loss"
        | "time_stop"
        | "manual_exit"
        | "daily_stop"
        | "kill_switch"
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
      alert_severity: ["info", "warning", "critical"],
      app_role: ["admin", "moderator", "user"],
      order_side: ["buy", "sell"],
      order_status: [
        "new",
        "working",
        "partially_filled",
        "filled",
        "canceled",
        "rejected",
        "expired",
      ],
      order_type: [
        "limit",
        "market",
        "ioc",
        "twap_parent",
        "twap_child",
        "post_only",
        "stop",
        "take_profit",
      ],
      position_side: ["long", "short"],
      strategy_name: ["breakout", "vwap_mr", "obi_scalper", "momentum"],
      trade_exit_reason: [
        "take_profit",
        "stop_loss",
        "time_stop",
        "manual_exit",
        "daily_stop",
        "kill_switch",
      ],
    },
  },
} as const
