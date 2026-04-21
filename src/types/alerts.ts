export type AlertSource = "portfolio" | "system" | "model" | "risk";
export type AlertOp = ">" | "<" | ">=" | "<=" | "==";
export type AlertActionKind = "pause" | "notify" | "flag" | "block";
export type AlertLevel = "info" | "warn" | "danger";

export interface AlertWhenSpec {
  source: AlertSource | string;
  metric: string;
  op: AlertOp;
  value: number;
  unit: string;
}

export interface AlertAction {
  kind: AlertActionKind;
  target?: string;
  channel?: string;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  when: AlertWhenSpec;
  then: readonly AlertAction[];
  fired: number;
  lastFired: string;
}

export interface AlertFiredEvent {
  ts: string;
  rule: string;
  detail: string;
  level: AlertLevel;
}
