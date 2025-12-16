#pragma once

#include "atlas/core/types.hpp"
#include "atlas/indicators/technical_indicators.hpp"
#include <deque>
#include <atomic>
#include <array>

namespace atlas::strategies {

// Ultra-low latency scalping strategy optimized for HFT
class ScalpingStrategy {
public:
    struct Config {
        double min_spread_bps = 2.0;        // Minimum spread in basis points
        double max_position_size = 10000.0;  // Maximum position in base currency
        double profit_target_bps = 5.0;      // Take profit in basis points
        double stop_loss_bps = 3.0;          // Stop loss in basis points
        int momentum_period = 20;            // Momentum calculation period
        double volume_multiplier = 1.5;      // Volume filter multiplier
        bool use_market_microstructure = true;
    };

private:
    Config config_;
    
    // Circular buffers for O(1) access
    std::array<core::MarketData, 1000> market_data_buffer_;
    std::atomic<size_t> buffer_head_{0};
    size_t buffer_size_{0};
    
    // Pre-calculated indicators for speed
    struct CachedIndicators {
        double momentum;
        double volume_ratio;
        double spread_ma;
        double volatility;
        int bid_ask_imbalance;
        double microstructure_score;
    };
    
    CachedIndicators cached_;
    std::atomic<bool> indicators_dirty_{true};
    
    // Order book imbalance tracking
    struct OrderBookMetrics {
        double bid_volume_weighted_price;
        double ask_volume_weighted_price;
        double imbalance_ratio;
        int levels_analyzed;
    };
    
public:
    explicit ScalpingStrategy(Config config = {}) 
        : config_(std::move(config)) {}
    
    // Main signal generation - optimized for speed
    [[nodiscard]] std::optional<core::Signal> process_tick(
        const core::MarketData& tick,
        const OrderBookMetrics& ob_metrics = {}) noexcept {
        
        // Update circular buffer
        const size_t idx = buffer_head_.fetch_add(1) % market_data_buffer_.size();
        market_data_buffer_[idx] = tick;
        buffer_size_ = std::min(buffer_size_ + 1, market_data_buffer_.size());
        
        // Skip if not enough data
        if (buffer_size_ < static_cast<size_t>(config_.momentum_period)) {
            return std::nullopt;
        }
        
        // Update indicators if needed
        if (indicators_dirty_.exchange(false)) {
            update_indicators();
        }
        
        // Check entry conditions
        return check_entry_conditions(tick, ob_metrics);
    }
    
    // Position sizing with Kelly Criterion
    [[nodiscard]] double calculate_position_size(
        const core::Signal& signal,
        double account_balance,
        double current_position = 0.0) const noexcept {
        
        // Kelly fraction calculation
        const double win_rate = 0.55;  // Historical win rate
        const double avg_win = config_.profit_target_bps / 10000.0;
        const double avg_loss = config_.stop_loss_bps / 10000.0;
        
        const double kelly_fraction = (win_rate * avg_win - (1 - win_rate) * avg_loss) / avg_win;
        const double adjusted_kelly = kelly_fraction * 0.25;  // Conservative Kelly
        
        // Risk-based position sizing
        const double risk_per_trade = account_balance * 0.01;  // 1% risk
        const double stop_distance = signal.risk_per_unit();
        double position_size = risk_per_trade / stop_distance;
        
        // Apply Kelly adjustment
        position_size *= adjusted_kelly;
        
        // Apply limits
        position_size = std::min(position_size, config_.max_position_size);
        position_size = std::min(position_size, account_balance * 0.1);  // Max 10% of account
        
        return position_size;
    }
    
private:
    void update_indicators() noexcept {
        if (buffer_size_ < 2) return;
        
        // Calculate momentum
        const size_t oldest_idx = (buffer_head_ - config_.momentum_period) % market_data_buffer_.size();
        const auto& oldest = market_data_buffer_[oldest_idx];
        const auto& newest = market_data_buffer_[(buffer_head_ - 1) % market_data_buffer_.size()];
        
        cached_.momentum = (newest.last - oldest.last) / oldest.last * 10000.0;  // In bps
        
        // Volume analysis
        double total_volume = 0.0;
        double avg_spread = 0.0;
        size_t count = std::min(static_cast<size_t>(config_.momentum_period), buffer_size_);
        
        for (size_t i = 0; i < count; ++i) {
            const auto& data = market_data_buffer_[(buffer_head_ - i - 1) % market_data_buffer_.size()];
            total_volume += data.last_size;
            avg_spread += data.spread();
        }
        
        cached_.volume_ratio = newest.last_size / (total_volume / count);
        cached_.spread_ma = avg_spread / count;
        
        // Simple volatility
        double price_sum = 0.0, price_sq_sum = 0.0;
        for (size_t i = 0; i < count; ++i) {
            const auto& data = market_data_buffer_[(buffer_head_ - i - 1) % market_data_buffer_.size()];
            price_sum += data.last;
            price_sq_sum += data.last * data.last;
        }
        
        const double mean = price_sum / count;
        const double variance = (price_sq_sum / count) - (mean * mean);
        cached_.volatility = std::sqrt(variance) / mean * 10000.0;  // In bps
    }
    
    [[nodiscard]] std::optional<core::Signal> check_entry_conditions(
        const core::MarketData& tick,
        const OrderBookMetrics& ob_metrics) const noexcept {
        
        // Spread filter
        const double spread_bps = tick.spread() / tick.mid() * 10000.0;
        if (spread_bps > config_.min_spread_bps) {
            return std::nullopt;
        }
        
        // Volume confirmation
        if (cached_.volume_ratio < config_.volume_multiplier) {
            return std::nullopt;
        }
        
        // Microstructure analysis
        double signal_strength = 0.0;
        core::Side direction;
        
        if (config_.use_market_microstructure && ob_metrics.levels_analyzed > 0) {
            // Order book imbalance signal
            if (ob_metrics.imbalance_ratio > 2.0 && cached_.momentum > 0) {
                direction = core::Side::BUY;
                signal_strength = std::min(ob_metrics.imbalance_ratio / 5.0, 1.0);
            } else if (ob_metrics.imbalance_ratio < 0.5 && cached_.momentum < 0) {
                direction = core::Side::SELL;
                signal_strength = std::min(1.0 / ob_metrics.imbalance_ratio / 5.0, 1.0);
            } else {
                return std::nullopt;
            }
        } else {
            // Pure momentum signal
            if (std::abs(cached_.momentum) < 5.0) {  // Minimum 5 bps move
                return std::nullopt;
            }
            
            direction = cached_.momentum > 0 ? core::Side::BUY : core::Side::SELL;
            signal_strength = std::min(std::abs(cached_.momentum) / 20.0, 1.0);
        }
        
        // Volatility filter
        if (cached_.volatility > 50.0) {  // Skip if volatility > 50 bps
            signal_strength *= 0.5;
        }
        
        // Generate signal
        const double entry_price = direction == core::Side::BUY ? tick.ask : tick.bid;
        const double stop_loss = direction == core::Side::BUY ?
            entry_price * (1.0 - config_.stop_loss_bps / 10000.0) :
            entry_price * (1.0 + config_.stop_loss_bps / 10000.0);
        const double take_profit = direction == core::Side::BUY ?
            entry_price * (1.0 + config_.profit_target_bps / 10000.0) :
            entry_price * (1.0 - config_.profit_target_bps / 10000.0);
        
        return core::Signal{
            .symbol = tick.symbol,
            .direction = direction,
            .entry_price = entry_price,
            .stop_loss = stop_loss,
            .take_profit = take_profit,
            .strength = signal_strength,
            .strategy = "scalping",
            .timestamp = tick.timestamp
        };
    }
};

} // namespace atlas::strategies
