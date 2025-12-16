#pragma once

#include <chrono>
#include <string>
#include <vector>
#include <cstdint>
#include <optional>

namespace atlas::core {

using Timestamp = std::chrono::time_point<std::chrono::system_clock>;
using Price = double;
using Volume = double;
using OrderId = std::string;

enum class Side {
    BUY,
    SELL
};

enum class OrderType {
    MARKET,
    LIMIT,
    STOP,
    STOP_LIMIT
};

enum class OrderStatus {
    NEW,
    PARTIALLY_FILLED,
    FILLED,
    CANCELLED,
    REJECTED
};

enum class TimeInForce {
    IOC,  // Immediate or Cancel
    FOK,  // Fill or Kill
    GTC,  // Good Till Cancelled
    GTD   // Good Till Date
};

struct MarketData {
    std::string symbol;
    Timestamp timestamp;
    Price bid;
    Price ask;
    Price last;
    Volume bid_size;
    Volume ask_size;
    Volume last_size;
    
    // For fast access in hot path
    Price mid() const noexcept {
        return (bid + ask) * 0.5;
    }
    
    Price spread() const noexcept {
        return ask - bid;
    }
};

struct OHLCV {
    Timestamp timestamp;
    Price open;
    Price high;
    Price low;
    Price close;
    Volume volume;
    
    // Cached computations for performance
    Price typical_price;
    Price weighted_close;
    
    void compute_derived() noexcept {
        typical_price = (high + low + close) / 3.0;
        weighted_close = (high + low + close * 2.0) / 4.0;
    }
};

struct Order {
    OrderId id;
    std::string symbol;
    Side side;
    OrderType type;
    Price price;
    Volume quantity;
    Volume filled_quantity;
    OrderStatus status;
    TimeInForce time_in_force;
    Timestamp created_at;
    std::optional<Timestamp> updated_at;
    
    bool is_active() const noexcept {
        return status == OrderStatus::NEW || 
               status == OrderStatus::PARTIALLY_FILLED;
    }
    
    Volume remaining() const noexcept {
        return quantity - filled_quantity;
    }
};

struct Fill {
    OrderId order_id;
    std::string trade_id;
    Price price;
    Volume quantity;
    Price fee;
    Timestamp timestamp;
};

struct Position {
    std::string symbol;
    Side side;
    Volume quantity;
    Price average_price;
    Price unrealized_pnl;
    Price realized_pnl;
    Timestamp opened_at;
    
    Price market_value(Price current_price) const noexcept {
        return quantity * current_price;
    }
    
    Price pnl(Price current_price) const noexcept {
        const Price diff = (side == Side::BUY) ? 
            (current_price - average_price) : 
            (average_price - current_price);
        return diff * quantity;
    }
};

// Memory-aligned structure for cache efficiency
struct alignas(64) Signal {
    std::string symbol;
    Side direction;
    Price entry_price;
    Price stop_loss;
    Price take_profit;
    double strength;  // 0.0 to 1.0
    std::string strategy;
    Timestamp timestamp;
    
    // Risk metrics
    Price risk_per_unit() const noexcept {
        return std::abs(entry_price - stop_loss);
    }
    
    double risk_reward_ratio() const noexcept {
        const Price risk = risk_per_unit();
        const Price reward = std::abs(take_profit - entry_price);
        return risk > 0 ? reward / risk : 0.0;
    }
};

} // namespace atlas::core
