export interface ModelMeta {
  name: string;
  arch: string;
  features: number;
  params: string;
  file: string;
  size: string;
  rocAuc: number;
  precision: number;
  recall: number;
  f1: number;
  brier: number;
  trainedOn: number;
  trainedAt: string;
}

export interface ShapFeature {
  k: string;
  v: number;
  sign: 1 | -1;
  desc: string;
}

export interface InferenceEvent {
  ts: string;
  sym: string;
  p: number;
  state: "ACCEPTED" | "REJECTED";
  top: string;
}

export interface ConfusionMatrixCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface CalibrationPoint {
  bin: number;
  pred: number;
  obs: number;
}

export interface TrainingRun {
  v: string;
  date: string;
  auc: number;
  prec: number;
  trades: number;
  note: string;
  live?: boolean;
}

export interface ModelData {
  meta: ModelMeta;
  shap: readonly ShapFeature[];
  infer: readonly InferenceEvent[];
  cm: ConfusionMatrixCounts;
  calibration: readonly CalibrationPoint[];
  runs: readonly TrainingRun[];
}
