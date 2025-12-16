#pragma once

#include "atlas/core/types.hpp"
#include <unordered_map>
#include <vector>
#include <mutex>
#include <algorithm>

namespace atlas::strategies {

// Multi-exchange arbitrage strategy for cross-market opportunities
class ArbitrageStrategy {
public:
    struct ExchangeQuote {
        std::string exchange;
        core::Price bid;
        core::Price ask;
        core::Volume bid_size;
        core::Volume ask_size;
        core::Timestamp timestamp;
        double latency_ms;  // Network latency to exchange
    };
    
    struct ArbitrageOpportunity {
        std::string symbol;
        std::string buy_exchange;
        std::string sell_exchange;
        core::Price buy_price;
        core::Price sell_price;
        core::Volume max_volume;
        double profit_bps;
        double execution_risk_score;  // 0-1, based on latency and market conditions
    };
    
    struct Config {
        double min_profit_bps = 10.0;       // Minimum profit in basis points
        double max_latency_ms = 50.0;       // Maximum acceptable latency
        double fee_bps = 10.0;              // Trading fee in basis points
        double slippage_bps = 2.0;          // Expected slippage
        bool triangular_enabled = true;      // Enable triangular arbitrage
        double max_exposure = 100000.0;      // Maximum exposure per opportunity
    };

private:
    Config config_;
    
    // Thread-safe quote storage
    mutable std::mutex quotes_mutex_;
    std::unordered_map<std::string, std::vector<ExchangeQuote>> quotes_by_symbol_;
    
    // Triangular arbitrage paths
    struct TriangularPath {
        std::string base;
        std::string quote;
        std::string bridge;
        std::vector<std::string> exchanges;
    };
    std::vector<TriangularPath> triangular_paths_;
    
public:
    explicit ArbitrageStrategy(Config config = {})
        : config_(std::move(config)) {
        initialize_triangular_paths();
    }
    
    // Update market quotes from an exchange
    void update_quote(const std::string& symbol, const ExchangeQuote& quote) {
        std::lock_guard<std::mutex> lock(quotes_mutex_);
        
        auto& quotes = quotes_by_symbol_[symbol];
        
        // Find and update or insert
        auto it = std::find_if(quotes.begin(), quotes.end(),
            [&](const ExchangeQuote& q) { return q.exchange == quote.exchange; });
        
        if (it != quotes.end()) {
            *it = quote;
        } else {
            quotes.push_back(quote);
        }
        
        // Remove stale quotes (> 1 second old)
        const auto now = std::chrono::system_clock::now();
        quotes.erase(
            std::remove_if(quotes.begin(), quotes.end(),
                [&](const ExchangeQuote& q) {
                    const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(
                        now - q.timestamp).count();
                    return age > 1000;
                }),
            quotes.end()
        );
    }
    
    // Find direct arbitrage opportunities
    [[nodiscard]] std::vector<ArbitrageOpportunity> find_opportunities() const {
        std::vector<ArbitrageOpportunity> opportunities;
        std::lock_guard<std::mutex> lock(quotes_mutex_);
        
        for (const auto& [symbol, quotes] : quotes_by_symbol_) {
            if (quotes.size() < 2) continue;
            
            // Find best bid and ask across exchanges
            const ExchangeQuote* best_bid = nullptr;
            const ExchangeQuote* best_ask = nullptr;
            
            for (const auto& quote : quotes) {
                if (!best_bid || quote.bid > best_bid->bid) {
                    best_bid = &quote;
                }
                if (!best_ask || quote.ask < best_ask->ask) {
                    best_ask = &quote;
                }
            }
            
            if (!best_bid || !best_ask || best_bid->exchange == best_ask->exchange) {
                continue;
            }
            
            // Calculate profit
            const double spread = best_bid->bid - best_ask->ask;
            const double mid_price = (best_bid->bid + best_ask->ask) / 2.0;
            const double profit_bps = (spread / mid_price) * 10000.0;
            
            // Account for fees and slippage
            const double net_profit_bps = profit_bps - 2 * config_.fee_bps - config_.slippage_bps;
            
            if (net_profit_bps >= config_.min_profit_bps) {
                // Check latency constraints
                if (best_bid->latency_ms > config_.max_latency_ms ||
                    best_ask->latency_ms > config_.max_latency_ms) {
                    continue;
                }
                
                // Calculate execution risk
                const double latency_risk = (best_bid->latency_ms + best_ask->latency_ms) / 
                                          (2.0 * config_.max_latency_ms);
                const double size_risk = 1.0 - std::min(best_bid->bid_size, best_ask->ask_size) / 
                                              config_.max_exposure;
                const double execution_risk = (latency_risk + size_risk) / 2.0;
                
                opportunities.push_back({
                    .symbol = symbol,
                    .buy_exchange = best_ask->exchange,
                    .sell_exchange = best_bid->exchange,
                    .buy_price = best_ask->ask,
                    .sell_price = best_bid->bid,
                    .max_volume = std::min({best_bid->bid_size, best_ask->ask_size, 
                                          config_.max_exposure / mid_price}),
                    .profit_bps = net_profit_bps,
                    .execution_risk_score = execution_risk
                });
            }
        }
        
        // Sort by profit potential
        std::sort(opportunities.begin(), opportunities.end(),
            [](const auto& a, const auto& b) {
                return a.profit_bps * (1.0 - a.execution_risk_score) > 
                       b.profit_bps * (1.0 - b.execution_risk_score);
            });
        
        return opportunities;
    }
    
    // Find triangular arbitrage opportunities
    [[nodiscard]] std::vector<ArbitrageOpportunity> find_triangular_opportunities() const {
        if (!config_.triangular_enabled) {
            return {};
        }
        
        std::vector<ArbitrageOpportunity> opportunities;
        std::lock_guard<std::mutex> lock(quotes_mutex_);
        
        // Example: BTC/USD -> ETH/USD -> ETH/BTC -> BTC
        for (const auto& path : triangular_paths_) {
            // Get quotes for each leg
            auto it1 = quotes_by_symbol_.find(path.base + "/" + path.quote);
            auto it2 = quotes_by_symbol_.find(path.bridge + "/" + path.quote);
            auto it3 = quotes_by_symbol_.find(path.bridge + "/" + path.base);
            
            if (it1 == quotes_by_symbol_.end() || 
                it2 == quotes_by_symbol_.end() || 
                it3 == quotes_by_symbol_.end()) {
                continue;
            }
            
            // Find best prices for triangular path
            // Buy BTC/USD, Sell ETH/USD, Buy ETH/BTC
            const auto& btc_usd_quotes = it1->second;
            const auto& eth_usd_quotes = it2->second;
            const auto& eth_btc_quotes = it3->second;
            
            if (btc_usd_quotes.empty() || eth_usd_quotes.empty() || eth_btc_quotes.empty()) {
                continue;
            }
            
            // Calculate synthetic BTC price through ETH
            for (const auto& btc_quote : btc_usd_quotes) {
                for (const auto& eth_usd : eth_usd_quotes) {
                    for (const auto& eth_btc : eth_btc_quotes) {
                        // Path: USD -> BTC -> ETH -> USD
                        const double btc_bought = 1.0 / btc_quote.ask;  // USD to BTC
                        const double eth_bought = btc_bought / eth_btc.ask;  // BTC to ETH
                        const double usd_received = eth_bought * eth_usd.bid;  // ETH to USD
                        
                        const double profit_ratio = usd_received - 1.0;
                        const double profit_bps = profit_ratio * 10000.0;
                        
                        // Account for 3x fees
                        const double net_profit_bps = profit_bps - 3 * config_.fee_bps;
                        
                        if (net_profit_bps >= config_.min_profit_bps) {
                            opportunities.push_back({
                                .symbol = "TRIANGULAR:" + path.base + "/" + path.bridge + "/" + path.quote,
                                .buy_exchange = btc_quote.exchange,
                                .sell_exchange = eth_usd.exchange,
                                .buy_price = btc_quote.ask,
                                .sell_price = eth_usd.bid,
                                .max_volume = std::min({btc_quote.ask_size * btc_quote.ask,
                                                      eth_usd.bid_size * eth_usd.bid,
                                                      eth_btc.ask_size * eth_btc.ask * btc_quote.ask}),
                                .profit_bps = net_profit_bps,
                                .execution_risk_score = 0.7  // Higher risk for triangular
                            });
                        }
                    }
                }
            }
        }
        
        return opportunities;
    }
    
    // Generate orders for an arbitrage opportunity
    [[nodiscard]] std::vector<core::Order> generate_orders(
        const ArbitrageOpportunity& opp,
        double position_size) const {
        
        std::vector<core::Order> orders;
        
        // Adjust size based on risk
        const double adjusted_size = position_size * (1.0 - opp.execution_risk_score);
        const double final_size = std::min(adjusted_size, opp.max_volume);
        
        // Buy order
        orders.push_back({
            .id = "ARB_BUY_" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()),
            .symbol = opp.symbol,
            .side = core::Side::BUY,
            .type = core::OrderType::LIMIT,
            .price = opp.buy_price * (1.0 + config_.slippage_bps / 10000.0),  // Add slippage buffer
            .quantity = final_size,
            .filled_quantity = 0.0,
            .status = core::OrderStatus::NEW,
            .time_in_force = core::TimeInForce::IOC,
            .created_at = std::chrono::system_clock::now()
        });
        
        // Sell order
        orders.push_back({
            .id = "ARB_SELL_" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()),
            .symbol = opp.symbol,
            .side = core::Side::SELL,
            .type = core::OrderType::LIMIT,
            .price = opp.sell_price * (1.0 - config_.slippage_bps / 10000.0),  // Subtract slippage buffer
            .quantity = final_size,
            .filled_quantity = 0.0,
            .status = core::OrderStatus::NEW,
            .time_in_force = core::TimeInForce::IOC,
            .created_at = std::chrono::system_clock::now()
        });
        
        return orders;
    }
    
private:
    void initialize_triangular_paths() {
        // Common triangular arbitrage paths
        triangular_paths_ = {
            {"BTC", "USD", "ETH", {}},
            {"BTC", "USD", "SOL", {}},
            {"ETH", "USD", "SOL", {}},
            {"BTC", "USDT", "ETH", {}},
            {"BTC", "EUR", "ETH", {}}
        };
    }
};

} // namespace atlas::strategies
