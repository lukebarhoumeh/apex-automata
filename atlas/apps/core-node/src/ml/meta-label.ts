/**
 * Meta-Label ONNX Model Integration
 * 
 * This module provides machine learning-based signal filtering using ONNX models.
 * The meta-labeling approach assigns a probability to each signal indicating
 * whether it's likely to be profitable.
 */

import * as ort from 'onnxruntime-node';
import { Logger } from '../core/logger';
import fs from 'fs';
import path from 'path';

export interface MetaLabelConfig {
  modelPath: string;       // Path to ONNX model file
  threshold: number;       // Minimum probability to accept signal (0-1)
  featureNames: string[];  // Expected feature names for logging
  enabled: boolean;
}

export interface SignalFeatures {
  // Technical indicators
  rsi: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  ema20: number;
  ema50: number;
  atr: number;
  atrPercent: number;
  
  // Volatility
  bbWidth: number;
  bbPosition: number;
  
  // Volume
  volumeRatio: number;  // Current volume / average volume
  
  // Price action
  candleBodyRatio: number;  // Body size / total range
  upperWickRatio: number;
  lowerWickRatio: number;
  
  // Trend
  trendStrength: number;  // ADX or similar
  priceVsEma: number;     // Price distance from EMA as %
}

export interface MetaLabelResult {
  probability: number;     // 0-1 probability of profitable trade
  accepted: boolean;       // Whether signal passes threshold
  confidence: string;      // 'high' | 'medium' | 'low'
  modelVersion?: string;
}

// Score distribution tracking for monitoring
interface ScoreDistribution {
  total: number;
  accepted: number;
  rejected: number;
  buckets: Record<string, number>;  // '0.0-0.1', '0.1-0.2', etc.
}

/**
 * MetaLabel class handles ONNX model loading and inference.
 */
export class MetaLabel {
  private config: MetaLabelConfig;
  private logger: Logger;
  private session: ort.InferenceSession | null = null;
  private modelLoaded = false;
  private scoreDistribution: ScoreDistribution = {
    total: 0,
    accepted: 0,
    rejected: 0,
    buckets: {
      '0.0-0.1': 0, '0.1-0.2': 0, '0.2-0.3': 0, '0.3-0.4': 0, '0.4-0.5': 0,
      '0.5-0.6': 0, '0.6-0.7': 0, '0.7-0.8': 0, '0.8-0.9': 0, '0.9-1.0': 0,
    },
  };

  constructor(config: MetaLabelConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    
    if (config.enabled) {
      if (!config.modelPath) {
        this.logger.warn(
          '⚠️  ML Meta-Label enabled but no modelPath configured. ' +
          'ML filtering will be DISABLED (signals pass through with neutral score 0.5). ' +
          'To enable: train a model and set metaLabeling.modelPath in config.'
        );
      } else {
        this.loadModel().catch(err => {
          this.logger.error('Failed to load meta-label model:', err);
        });
      }
    } else {
      this.logger.info('ML Meta-Label filtering is disabled (rule-based MetaFilter is still active)');
    }
  }

  /**
   * Load the ONNX model from disk.
   */
  private async loadModel(): Promise<void> {
    if (!this.config.modelPath) {
      this.logger.warn('Meta-label model path not configured');
      return;
    }

    const fullPath = path.resolve(this.config.modelPath);
    
    if (!fs.existsSync(fullPath)) {
      this.logger.warn(
        `⚠️  Meta-label ONNX model not found at: ${fullPath}\n` +
        '   ML signal filtering will be DISABLED. To enable:\n' +
        '   1. Collect trade outcomes via the trade_outcomes table\n' +
        '   2. Train a classifier (see docs/ml-training.md)\n' +
        '   3. Export to ONNX and place at the configured path'
      );
      return;
    }

    try {
      this.logger.info(`Loading meta-label model from ${fullPath}`);
      this.session = await ort.InferenceSession.create(fullPath);
      this.modelLoaded = true;
      
      // Log model info
      const inputNames = this.session.inputNames;
      const outputNames = this.session.outputNames;
      
      this.logger.info('Meta-label model loaded successfully', {
        inputNames,
        outputNames,
      });
    } catch (error) {
      this.logger.error('Failed to create ONNX session:', error);
      this.modelLoaded = false;
    }
  }

  /**
   * Check if the model is ready for inference.
   */
  public isReady(): boolean {
    return this.config.enabled && this.modelLoaded && this.session !== null;
  }

  /**
   * Extract features from signal context for model input.
   */
  public extractFeatures(context: Partial<SignalFeatures>): Float32Array {
    // Default values for missing features
    const defaults: SignalFeatures = {
      rsi: 50,
      macd: 0,
      macdSignal: 0,
      macdHistogram: 0,
      ema20: 0,
      ema50: 0,
      atr: 0,
      atrPercent: 0.01,
      bbWidth: 0.02,
      bbPosition: 0.5,
      volumeRatio: 1,
      candleBodyRatio: 0.5,
      upperWickRatio: 0.25,
      lowerWickRatio: 0.25,
      trendStrength: 25,
      priceVsEma: 0,
    };

    const features = { ...defaults, ...context };
    
    // Normalize features
    const normalized = new Float32Array([
      (features.rsi - 50) / 50,                    // RSI: -1 to 1
      features.macd / 100,                         // MACD: normalized
      features.macdSignal / 100,
      features.macdHistogram / 50,
      features.atrPercent * 100,                   // ATR%: scaled
      (features.bbPosition - 0.5) * 2,             // BB Position: -1 to 1
      features.bbWidth * 50,                       // BB Width: scaled
      Math.log1p(features.volumeRatio),            // Volume ratio: log scale
      features.candleBodyRatio,
      (features.trendStrength - 25) / 25,          // ADX: -1 to 1
      features.priceVsEma * 100,                   // Price vs EMA %
    ]);

    return normalized;
  }

  /**
   * Run inference on the model.
   */
  public async predict(features: SignalFeatures): Promise<MetaLabelResult> {
    // If model not ready, return neutral result
    if (!this.isReady()) {
      return {
        probability: 0.5,
        accepted: true,  // Allow signal through if model not available
        confidence: 'medium',
      };
    }

    try {
      const inputArray = this.extractFeatures(features);
      
      // Create input tensor
      const inputTensor = new ort.Tensor('float32', inputArray, [1, inputArray.length]);
      
      // Run inference
      const results = await this.session!.run({
        input: inputTensor,  // Adjust input name if model uses different name
      });

      // Get output probability
      // Assumes model outputs a single probability value
      const output = results.output || results.probabilities || Object.values(results)[0];
      const probability = (output.data as Float32Array)[0];
      
      // Determine acceptance
      const accepted = probability >= this.config.threshold;
      
      // Determine confidence level
      let confidence: 'high' | 'medium' | 'low';
      if (probability > 0.7 || probability < 0.3) {
        confidence = 'high';
      } else if (probability > 0.55 || probability < 0.45) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }

      // Update distribution tracking
      this.updateDistribution(probability, accepted);

      return {
        probability,
        accepted,
        confidence,
      };
    } catch (error) {
      this.logger.error('Meta-label inference failed:', error);
      return {
        probability: 0.5,
        accepted: true,
        confidence: 'low',
      };
    }
  }

  /**
   * Update score distribution for monitoring.
   */
  private updateDistribution(probability: number, accepted: boolean): void {
    this.scoreDistribution.total++;
    
    if (accepted) {
      this.scoreDistribution.accepted++;
    } else {
      this.scoreDistribution.rejected++;
    }

    // Update bucket
    const bucketIndex = Math.min(Math.floor(probability * 10), 9);
    const bucketKey = `${(bucketIndex / 10).toFixed(1)}-${((bucketIndex + 1) / 10).toFixed(1)}`;
    this.scoreDistribution.buckets[bucketKey] = 
      (this.scoreDistribution.buckets[bucketKey] || 0) + 1;
  }

  /**
   * Get score distribution for monitoring.
   */
  public getDistribution(): ScoreDistribution {
    return { ...this.scoreDistribution };
  }

  /**
   * Log distribution summary.
   */
  public logDistributionSummary(): void {
    const dist = this.scoreDistribution;
    const acceptRate = dist.total > 0 
      ? ((dist.accepted / dist.total) * 100).toFixed(1) 
      : '0';

    this.logger.info('Meta-label distribution summary', {
      total: dist.total,
      accepted: dist.accepted,
      rejected: dist.rejected,
      acceptRate: `${acceptRate}%`,
      buckets: dist.buckets,
    });
  }

  /**
   * Reset distribution tracking.
   */
  public resetDistribution(): void {
    this.scoreDistribution = {
      total: 0,
      accepted: 0,
      rejected: 0,
      buckets: {
        '0.0-0.1': 0, '0.1-0.2': 0, '0.2-0.3': 0, '0.3-0.4': 0, '0.4-0.5': 0,
        '0.5-0.6': 0, '0.6-0.7': 0, '0.7-0.8': 0, '0.8-0.9': 0, '0.9-1.0': 0,
      },
    };
  }
}
