#pragma once

#include "atlas/core/types.hpp"
#include <vector>
#include <deque>
#include <cmath>
#include <algorithm>
#include <numeric>

namespace atlas::ml {

// High-performance feature engineering for ML models
class FeatureEngineering {
public:
    // Microstructure features
    struct MicrostructureFeatures {
        double bid_ask_spread;
        double bid_ask_imbalance;
        double order_flow_imbalance;
        double effective_spread;
        double realized_spread;
        double price_impact;
        double kyle_lambda;  // Price impact coefficient
        double amihud_illiquidity;
        double volume_clock_intensity;
        double trade_sign_autocorrelation;
    };
    
    // Technical features
    struct TechnicalFeatures {
        double returns_1m;
        double returns_5m;
        double returns_15m;
        double log_returns;
        double volatility_realized;
        double volatility_garch;
        double rsi;
        double macd_signal;
        double bollinger_position;
        double volume_ratio;
        double price_momentum;
        double mean_reversion_score;
    };
    
    // Market regime features
    struct RegimeFeatures {
        double trend_strength;
        double volatility_regime;
        double correlation_breakdown;
        double market_efficiency;
        double fractal_dimension;
        double hurst_exponent;
        int detected_regime;  // 0: Range, 1: Trend, 2: Volatile
    };
    
private:
    // Circular buffers for efficient computation
    std::deque<core::MarketData> market_data_;
    std::deque<core::OHLCV> ohlcv_data_;
    size_t max_lookback_;
    
    // Pre-computed values for efficiency
    mutable struct Cache {
        bool dirty = true;
        std::vector<double> returns;
        double mean_return;
        double std_return;
        std::vector<double> signed_volumes;
    } cache_;
    
public:
    explicit FeatureEngineering(size_t max_lookback = 1000)
        : max_lookback_(max_lookback) {
        market_data_.reserve(max_lookback);
        ohlcv_data_.reserve(max_lookback);
    }
    
    // Update with new tick data
    void add_tick(const core::MarketData& tick) {
        market_data_.push_back(tick);
        if (market_data_.size() > max_lookback_) {
            market_data_.pop_front();
        }
        cache_.dirty = true;
    }
    
    // Update with OHLCV bar
    void add_bar(const core::OHLCV& bar) {
        ohlcv_data_.push_back(bar);
        if (ohlcv_data_.size() > max_lookback_) {
            ohlcv_data_.pop_front();
        }
        cache_.dirty = true;
    }
    
    // Extract all features for ML model
    [[nodiscard]] std::vector<double> extract_features() const {
        std::vector<double> features;
        features.reserve(50);  // Pre-allocate for efficiency
        
        // Extract different feature groups
        const auto micro = calculate_microstructure_features();
        const auto tech = calculate_technical_features();
        const auto regime = calculate_regime_features();
        
        // Flatten into feature vector
        features.push_back(micro.bid_ask_spread);
        features.push_back(micro.bid_ask_imbalance);
        features.push_back(micro.order_flow_imbalance);
        features.push_back(micro.effective_spread);
        features.push_back(micro.kyle_lambda);
        features.push_back(micro.volume_clock_intensity);
        
        features.push_back(tech.returns_1m);
        features.push_back(tech.returns_5m);
        features.push_back(tech.volatility_realized);
        features.push_back(tech.rsi);
        features.push_back(tech.macd_signal);
        features.push_back(tech.bollinger_position);
        features.push_back(tech.volume_ratio);
        features.push_back(tech.mean_reversion_score);
        
        features.push_back(regime.trend_strength);
        features.push_back(regime.volatility_regime);
        features.push_back(regime.hurst_exponent);
        features.push_back(static_cast<double>(regime.detected_regime));
        
        // Normalize features
        normalize_features(features);
        
        return features;
    }
    
    [[nodiscard]] MicrostructureFeatures calculate_microstructure_features() const {
        MicrostructureFeatures features{};
        
        if (market_data_.size() < 10) return features;
        
        const auto& latest = market_data_.back();
        
        // Basic spread metrics
        features.bid_ask_spread = latest.spread();
        features.bid_ask_imbalance = (latest.bid_size - latest.ask_size) / 
                                     (latest.bid_size + latest.ask_size);
        
        // Order flow imbalance (requires trade classification)
        double buy_volume = 0.0, sell_volume = 0.0;
        for (size_t i = 1; i < market_data_.size(); ++i) {
            const auto& curr = market_data_[i];
            const auto& prev = market_data_[i-1];
            
            // Lee-Ready algorithm for trade classification
            const double mid_prev = prev.mid();
            if (curr.last > mid_prev) {
                buy_volume += curr.last_size;
            } else if (curr.last < mid_prev) {
                sell_volume += curr.last_size;
            } else {
                // Use tick rule
                if (curr.last > prev.last) {
                    buy_volume += curr.last_size;
                } else {
                    sell_volume += curr.last_size;
                }
            }
        }
        
        features.order_flow_imbalance = (buy_volume - sell_volume) / (buy_volume + sell_volume + 1e-10);
        
        // Kyle's lambda (price impact)
        if (cache_.dirty) update_cache();
        
        if (cache_.returns.size() > 10 && cache_.signed_volumes.size() > 10) {
            // Regress returns on signed volume
            double cov = 0.0, var = 0.0;
            const double mean_vol = std::accumulate(cache_.signed_volumes.begin(), 
                                                  cache_.signed_volumes.end(), 0.0) / 
                                  cache_.signed_volumes.size();
            
            for (size_t i = 0; i < cache_.returns.size(); ++i) {
                const double vol_dev = cache_.signed_volumes[i] - mean_vol;
                cov += (cache_.returns[i] - cache_.mean_return) * vol_dev;
                var += vol_dev * vol_dev;
            }
            
            features.kyle_lambda = var > 0 ? cov / var : 0.0;
        }
        
        // Amihud illiquidity
        double amihud_sum = 0.0;
        int amihud_count = 0;
        for (size_t i = 1; i < market_data_.size(); ++i) {
            const auto& curr = market_data_[i];
            const auto& prev = market_data_[i-1];
            const double ret = std::abs(curr.last - prev.last) / prev.last;
            const double dollar_volume = curr.last * curr.last_size;
            if (dollar_volume > 0) {
                amihud_sum += ret / dollar_volume;
                amihud_count++;
            }
        }
        features.amihud_illiquidity = amihud_count > 0 ? amihud_sum / amihud_count * 1e6 : 0.0;
        
        return features;
    }
    
    [[nodiscard]] TechnicalFeatures calculate_technical_features() const {
        TechnicalFeatures features{};
        
        if (ohlcv_data_.size() < 20) return features;
        
        // Returns at different horizons
        const auto& latest = ohlcv_data_.back();
        if (ohlcv_data_.size() > 1) {
            features.returns_1m = (latest.close - ohlcv_data_[ohlcv_data_.size()-2].close) / 
                                 ohlcv_data_[ohlcv_data_.size()-2].close;
        }
        if (ohlcv_data_.size() > 5) {
            features.returns_5m = (latest.close - ohlcv_data_[ohlcv_data_.size()-6].close) / 
                                 ohlcv_data_[ohlcv_data_.size()-6].close;
        }
        if (ohlcv_data_.size() > 15) {
            features.returns_15m = (latest.close - ohlcv_data_[ohlcv_data_.size()-16].close) / 
                                  ohlcv_data_[ohlcv_data_.size()-16].close;
        }
        
        // Realized volatility
        if (cache_.dirty) update_cache();
        features.volatility_realized = cache_.std_return * std::sqrt(252 * 24 * 12);  // Annualized
        
        // RSI
        double gains = 0.0, losses = 0.0;
        const size_t rsi_period = 14;
        if (ohlcv_data_.size() > rsi_period) {
            for (size_t i = ohlcv_data_.size() - rsi_period; i < ohlcv_data_.size(); ++i) {
                const double change = ohlcv_data_[i].close - ohlcv_data_[i-1].close;
                if (change > 0) gains += change;
                else losses -= change;
            }
            const double avg_gain = gains / rsi_period;
            const double avg_loss = losses / rsi_period;
            const double rs = avg_loss > 0 ? avg_gain / avg_loss : 100.0;
            features.rsi = 100.0 - (100.0 / (1.0 + rs));
        }
        
        // Bollinger bands position
        const size_t bb_period = 20;
        if (ohlcv_data_.size() >= bb_period) {
            double sum = 0.0, sum_sq = 0.0;
            for (size_t i = ohlcv_data_.size() - bb_period; i < ohlcv_data_.size(); ++i) {
                sum += ohlcv_data_[i].close;
                sum_sq += ohlcv_data_[i].close * ohlcv_data_[i].close;
            }
            const double mean = sum / bb_period;
            const double std = std::sqrt(sum_sq / bb_period - mean * mean);
            features.bollinger_position = (latest.close - mean) / (2.0 * std);  // Normalized position
        }
        
        // Mean reversion score
        if (ohlcv_data_.size() >= 20) {
            const double ma_20 = std::accumulate(
                ohlcv_data_.end() - 20, ohlcv_data_.end(), 0.0,
                [](double sum, const core::OHLCV& bar) { return sum + bar.close; }
            ) / 20.0;
            features.mean_reversion_score = (latest.close - ma_20) / ma_20;
        }
        
        return features;
    }
    
    [[nodiscard]] RegimeFeatures calculate_regime_features() const {
        RegimeFeatures features{};
        
        if (ohlcv_data_.size() < 100) return features;
        
        // Trend strength using ADX-like calculation
        double sum_up = 0.0, sum_down = 0.0;
        for (size_t i = 1; i < std::min(size_t(20), ohlcv_data_.size()); ++i) {
            const double change = ohlcv_data_[ohlcv_data_.size()-i].close - 
                                ohlcv_data_[ohlcv_data_.size()-i-1].close;
            if (change > 0) sum_up += change;
            else sum_down -= change;
        }
        features.trend_strength = (sum_up - sum_down) / (sum_up + sum_down + 1e-10);
        
        // Volatility regime (high/medium/low)
        if (cache_.dirty) update_cache();
        const double current_vol = cache_.std_return;
        const double vol_percentile = calculate_volatility_percentile(current_vol);
        features.volatility_regime = vol_percentile;
        
        // Simplified Hurst exponent
        features.hurst_exponent = calculate_hurst_exponent();
        
        // Detect regime
        if (features.trend_strength > 0.3 && features.volatility_regime < 0.5) {
            features.detected_regime = 1;  // Trending
        } else if (features.volatility_regime > 0.7) {
            features.detected_regime = 2;  // Volatile
        } else {
            features.detected_regime = 0;  // Range-bound
        }
        
        return features;
    }
    
private:
    void update_cache() const {
        cache_.returns.clear();
        cache_.signed_volumes.clear();
        
        if (market_data_.size() < 2) {
            cache_.dirty = false;
            return;
        }
        
        // Calculate returns and signed volumes
        for (size_t i = 1; i < market_data_.size(); ++i) {
            const double ret = (market_data_[i].last - market_data_[i-1].last) / market_data_[i-1].last;
            cache_.returns.push_back(ret);
            
            // Sign volume by trade direction
            const double mid_prev = market_data_[i-1].mid();
            const double signed_vol = market_data_[i].last > mid_prev ? 
                                     market_data_[i].last_size : -market_data_[i].last_size;
            cache_.signed_volumes.push_back(signed_vol);
        }
        
        // Calculate statistics
        cache_.mean_return = std::accumulate(cache_.returns.begin(), cache_.returns.end(), 0.0) / 
                           cache_.returns.size();
        
        double sum_sq = 0.0;
        for (const double ret : cache_.returns) {
            sum_sq += (ret - cache_.mean_return) * (ret - cache_.mean_return);
        }
        cache_.std_return = std::sqrt(sum_sq / cache_.returns.size());
        
        cache_.dirty = false;
    }
    
    [[nodiscard]] double calculate_volatility_percentile(double current_vol) const {
        std::vector<double> historical_vols;
        const size_t window = 20;
        
        for (size_t i = window; i < ohlcv_data_.size(); i += window) {
            double sum_sq = 0.0;
            for (size_t j = i - window; j < i; ++j) {
                const double ret = (ohlcv_data_[j].close - ohlcv_data_[j-1].close) / ohlcv_data_[j-1].close;
                sum_sq += ret * ret;
            }
            historical_vols.push_back(std::sqrt(sum_sq / window));
        }
        
        if (historical_vols.empty()) return 0.5;
        
        std::sort(historical_vols.begin(), historical_vols.end());
        const auto it = std::lower_bound(historical_vols.begin(), historical_vols.end(), current_vol);
        return static_cast<double>(std::distance(historical_vols.begin(), it)) / historical_vols.size();
    }
    
    [[nodiscard]] double calculate_hurst_exponent() const {
        if (ohlcv_data_.size() < 100) return 0.5;
        
        // Simplified R/S analysis
        std::vector<double> log_prices;
        for (const auto& bar : ohlcv_data_) {
            log_prices.push_back(std::log(bar.close));
        }
        
        std::vector<std::pair<double, double>> rs_values;
        
        for (size_t n = 10; n <= 50 && n < log_prices.size(); n += 10) {
            double total_rs = 0.0;
            int count = 0;
            
            for (size_t start = 0; start + n < log_prices.size(); start += n) {
                // Calculate returns
                std::vector<double> returns;
                for (size_t i = start + 1; i < start + n; ++i) {
                    returns.push_back(log_prices[i] - log_prices[i-1]);
                }
                
                // Mean and std
                const double mean = std::accumulate(returns.begin(), returns.end(), 0.0) / returns.size();
                double sum_sq = 0.0;
                for (const double r : returns) {
                    sum_sq += (r - mean) * (r - mean);
                }
                const double std = std::sqrt(sum_sq / returns.size());
                
                if (std > 0) {
                    // Calculate range
                    double cumsum = 0.0;
                    double max_cumsum = 0.0;
                    double min_cumsum = 0.0;
                    
                    for (const double r : returns) {
                        cumsum += (r - mean);
                        max_cumsum = std::max(max_cumsum, cumsum);
                        min_cumsum = std::min(min_cumsum, cumsum);
                    }
                    
                    const double range = max_cumsum - min_cumsum;
                    total_rs += range / std;
                    count++;
                }
            }
            
            if (count > 0) {
                rs_values.emplace_back(std::log(static_cast<double>(n)), 
                                      std::log(total_rs / count));
            }
        }
        
        if (rs_values.size() < 2) return 0.5;
        
        // Linear regression to estimate Hurst exponent
        double sum_x = 0.0, sum_y = 0.0, sum_xy = 0.0, sum_xx = 0.0;
        for (const auto& [x, y] : rs_values) {
            sum_x += x;
            sum_y += y;
            sum_xy += x * y;
            sum_xx += x * x;
        }
        
        const size_t n = rs_values.size();
        const double hurst = (n * sum_xy - sum_x * sum_y) / (n * sum_xx - sum_x * sum_x);
        
        return std::clamp(hurst, 0.0, 1.0);
    }
    
    void normalize_features(std::vector<double>& features) const {
        // Z-score normalization with clipping
        for (auto& f : features) {
            if (!std::isfinite(f)) {
                f = 0.0;
            } else {
                f = std::clamp(f, -3.0, 3.0);  // Clip to ±3 std devs
            }
        }
    }
};

} // namespace atlas::ml
