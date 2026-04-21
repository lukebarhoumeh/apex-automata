export interface AccountInfo {
  name: string;
  email: string;
  plan: string;
  seat: string;
}

export interface Venue {
  name: string;
  kind: string;
  status: "connected" | "disabled";
  latency: number | null;
  key: string | null;
}

export interface NotificationChannel {
  channel: "Slack" | "Email" | "PagerDuty" | "SMS" | "Webhook" | string;
  enabled: boolean;
  target: string;
}

export interface RiskLimits {
  maxPortfolioHeatPct: number;
  maxDrawdownPct: number;
  maxPositionPct: number;
  maxConsecLosses: number;
  maxDailyLoss: number;
  allowShort: boolean;
  allowOvernight: boolean;
  killSwitchArmed: boolean;
}

export interface SettingsData {
  account: AccountInfo;
  venues: readonly Venue[];
  notifications: readonly NotificationChannel[];
  riskLimits: RiskLimits;
}
