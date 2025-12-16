#pragma once

#include "atlas/core/types.hpp"
#include <vector>
#include <queue>
#include <unordered_map>
#include <atomic>
#include <chrono>
#include <algorithm>

namespace atlas::execution {

// Ultra-low latency smart order router with advanced execution algorithms
class SmartOrderRouter {
public:
    struct RouteMetrics {
        std::string exchange;
        double latency_ms;
        double fill_rate;
        double effective_spread;
        double available_liquidity;
        double fee_bps;
        int priority_score;  // Lower is better
    };
    
    struct ExecutionPlan {
        struct Slice {
            std::string exchange;
            core::Volume quantity;
            core::Price limit_price;
            std::chrono::milliseconds delay;
            core::OrderType order_type;
        };
        
        std::vector<Slice> slices;
        double expected_cost;
        double expected_slippage_bps;
        std::chrono::milliseconds total_execution_time;
    };
    
    enum class Algorithm {
        TWAP,           // Time-weighted average price
        VWAP,           // Volume-weighted average price
        ICEBERG,        // Hidden quantity
        SNIPER,         // Aggressive liquidity taking
        STEALTH,        // Minimal market impact
        ADAPTIVE        // ML-based adaptive routing
    };
    
private:
    // Exchange metrics tracking
    std::unordered_map<std::string, RouteMetrics> exchange_metrics_;
    std::atomic<size_t> order_counter_{0};
    
    // Market impact model parameters
    struct MarketImpactModel {
        double temporary_impact_coefficient = 0.1;
        double permanent_impact_coefficient = 0.05;
        double urgency_multiplier = 1.0;
    } impact_model_;
    
    // Execution algorithm configs
    struct AlgorithmConfig {
        double max_participation_rate = 0.1;  // Max 10% of volume
        double min_slice_size = 100.0;
        double max_slice_size = 10000.0;
        std::chrono::milliseconds min_interval{100};
        std::chrono::milliseconds max_interval{5000};
    } algo_config_;
    
public:
    // Update exchange metrics from real-time data
    void update_metrics(const std::string& exchange, const RouteMetrics& metrics) {
        exchange_metrics_[exchange] = metrics;
    }
    
    // Generate optimal execution plan
    [[nodiscard]] ExecutionPlan create_execution_plan(
        const core::Order& parent_order,
        Algorithm algo = Algorithm::ADAPTIVE,
        double urgency = 0.5) const {
        
        ExecutionPlan plan;
        
        switch (algo) {
            case Algorithm::TWAP:
                plan = create_twap_plan(parent_order, urgency);
                break;
            case Algorithm::VWAP:
                plan = create_vwap_plan(parent_order, urgency);
                break;
            case Algorithm::ICEBERG:
                plan = create_iceberg_plan(parent_order, urgency);
                break;
            case Algorithm::SNIPER:
                plan = create_sniper_plan(parent_order);
                break;
            case Algorithm::STEALTH:
                plan = create_stealth_plan(parent_order);
                break;
            case Algorithm::ADAPTIVE:
                plan = create_adaptive_plan(parent_order, urgency);
                break;
        }
        
        // Calculate expected costs
        calculate_execution_costs(plan, parent_order);
        
        return plan;
    }
    
    // Split large orders optimally across exchanges
    [[nodiscard]] std::vector<core::Order> split_order(
        const core::Order& parent_order,
        const ExecutionPlan& plan) const {
        
        std::vector<core::Order> child_orders;
        
        for (const auto& slice : plan.slices) {
            core::Order child = parent_order;
            child.id = generate_order_id(parent_order.id);
            child.quantity = slice.quantity;
            child.price = slice.limit_price;
            child.type = slice.order_type;
            
            // Add exchange routing info (would be in metadata in real system)
            child_orders.push_back(std::move(child));
        }
        
        return child_orders;
    }
    
    // Adaptive order placement based on real-time conditions
    [[nodiscard]] std::vector<std::pair<std::string, core::Order>> route_order_adaptive(
        const core::Order& order,
        const std::unordered_map<std::string, core::MarketData>& market_data) const {
        
        std::vector<std::pair<std::string, core::Order>> routed_orders;
        
        // Rank exchanges by execution quality
        std::vector<std::pair<std::string, int>> exchange_ranking;
        
        for (const auto& [exchange, metrics] : exchange_metrics_) {
            // Skip if no recent market data
            auto it = market_data.find(exchange);
            if (it == market_data.end()) continue;
            
            const auto& md = it->second;
            
            // Calculate composite score
            int score = 0;
            
            // Latency score (lower is better)
            score += static_cast<int>(metrics.latency_ms);
            
            // Spread cost
            const double spread_cost = md.spread() / md.mid() * 10000.0;  // In bps
            score += static_cast<int>(spread_cost * 10);
            
            // Liquidity score
            const double available_size = (order.side == core::Side::BUY) ? 
                                        md.ask_size : md.bid_size;
            if (available_size < order.quantity * 0.1) {
                score += 1000;  // Penalty for low liquidity
            }
            
            // Fee score
            score += static_cast<int>(metrics.fee_bps * 10);
            
            exchange_ranking.emplace_back(exchange, score);
        }
        
        // Sort by score (ascending)
        std::sort(exchange_ranking.begin(), exchange_ranking.end(),
                  [](const auto& a, const auto& b) { return a.second < b.second; });
        
        // Distribute order across top exchanges
        core::Volume remaining = order.quantity;
        const size_t max_venues = std::min(size_t(3), exchange_ranking.size());
        
        for (size_t i = 0; i < max_venues && remaining > 0; ++i) {
            const auto& [exchange, score] = exchange_ranking[i];
            
            // Allocate based on ranking (more to better exchanges)
            const double allocation_pct = (max_venues - i) / 
                                        (double)(max_venues * (max_venues + 1) / 2);
            core::Volume slice_size = std::min(remaining, order.quantity * allocation_pct);
            
            // Respect minimum order size
            if (slice_size < algo_config_.min_slice_size && i < max_venues - 1) {
                continue;
            }
            
            core::Order slice = order;
            slice.id = generate_order_id(order.id);
            slice.quantity = slice_size;
            
            // Adjust price based on urgency
            if (order.type == core::OrderType::LIMIT) {
                const auto& md = market_data.at(exchange);
                const double urgency_adj = (order.side == core::Side::BUY) ? 1.0001 : 0.9999;
                slice.price = order.price * urgency_adj;
            }
            
            routed_orders.emplace_back(exchange, std::move(slice));
            remaining -= slice_size;
        }
        
        return routed_orders;
    }
    
private:
    [[nodiscard]] ExecutionPlan create_twap_plan(
        const core::Order& order, 
        double urgency) const {
        
        ExecutionPlan plan;
        
        // Calculate time slices
        const auto total_time = std::chrono::milliseconds(
            static_cast<long>(5000 * (1.0 - urgency) + 1000));
        const int num_slices = std::max(1, static_cast<int>(order.quantity / algo_config_.min_slice_size));
        const auto interval = total_time / num_slices;
        
        const core::Volume slice_size = order.quantity / num_slices;
        
        // Create uniform time slices
        for (int i = 0; i < num_slices; ++i) {
            ExecutionPlan::Slice slice;
            slice.quantity = (i == num_slices - 1) ? 
                           order.quantity - slice_size * (num_slices - 1) : slice_size;
            slice.limit_price = order.price;
            slice.delay = interval * i;
            slice.order_type = core::OrderType::LIMIT;
            
            // Route to best exchange (simplified)
            slice.exchange = select_best_exchange(order.symbol);
            
            plan.slices.push_back(slice);
        }
        
        plan.total_execution_time = total_time;
        return plan;
    }
    
    [[nodiscard]] ExecutionPlan create_vwap_plan(
        const core::Order& order, 
        double urgency) const {
        
        ExecutionPlan plan;
        
        // In real implementation, would use historical volume profile
        // For now, use a typical U-shaped volume distribution
        std::vector<double> volume_profile = {
            0.15, 0.10, 0.08, 0.07, 0.06, 0.06, 0.06, 0.07, 0.08, 0.10, 0.17
        };
        
        auto current_time = std::chrono::milliseconds(0);
        const auto time_per_bucket = std::chrono::milliseconds(500);
        
        for (size_t i = 0; i < volume_profile.size(); ++i) {
            ExecutionPlan::Slice slice;
            slice.quantity = order.quantity * volume_profile[i];
            slice.limit_price = order.price;
            slice.delay = current_time;
            slice.order_type = core::OrderType::LIMIT;
            slice.exchange = select_best_exchange(order.symbol);
            
            plan.slices.push_back(slice);
            current_time += time_per_bucket;
        }
        
        plan.total_execution_time = current_time;
        return plan;
    }
    
    [[nodiscard]] ExecutionPlan create_iceberg_plan(
        const core::Order& order, 
        double urgency) const {
        
        ExecutionPlan plan;
        
        // Show only small portions, refill as executed
        const core::Volume display_size = std::min(
            algo_config_.min_slice_size * 2, 
            order.quantity * 0.1
        );
        
        const int num_refills = static_cast<int>(order.quantity / display_size);
        
        for (int i = 0; i < num_refills; ++i) {
            ExecutionPlan::Slice slice;
            slice.quantity = (i == num_refills - 1) ? 
                           order.quantity - display_size * (num_refills - 1) : display_size;
            slice.limit_price = order.price;
            slice.delay = std::chrono::milliseconds(0);  // All at once, but hidden
            slice.order_type = core::OrderType::LIMIT;
            slice.exchange = select_best_exchange(order.symbol);
            
            plan.slices.push_back(slice);
        }
        
        plan.total_execution_time = std::chrono::milliseconds(0);
        return plan;
    }
    
    [[nodiscard]] ExecutionPlan create_sniper_plan(const core::Order& order) const {
        ExecutionPlan plan;
        
        // Aggressive taking of available liquidity
        ExecutionPlan::Slice slice;
        slice.quantity = order.quantity;
        slice.limit_price = order.price * 1.001;  // Slight premium for immediate fill
        slice.delay = std::chrono::milliseconds(0);
        slice.order_type = core::OrderType::LIMIT;  // Could be MARKET for more aggression
        slice.exchange = select_best_exchange(order.symbol);
        
        plan.slices.push_back(slice);
        plan.total_execution_time = std::chrono::milliseconds(0);
        
        return plan;
    }
    
    [[nodiscard]] ExecutionPlan create_stealth_plan(const core::Order& order) const {
        ExecutionPlan plan;
        
        // Random-sized slices at random intervals to avoid detection
        std::vector<double> random_sizes = {0.07, 0.13, 0.09, 0.11, 0.15, 0.08, 0.12, 0.10, 0.15};
        std::vector<int> random_delays = {0, 200, 150, 300, 100, 250, 180, 220, 170};
        
        core::Volume remaining = order.quantity;
        auto current_time = std::chrono::milliseconds(0);
        
        for (size_t i = 0; i < random_sizes.size() && remaining > 0; ++i) {
            ExecutionPlan::Slice slice;
            slice.quantity = std::min(remaining, order.quantity * random_sizes[i]);
            slice.limit_price = order.price;
            slice.delay = current_time;
            slice.order_type = core::OrderType::LIMIT;
            slice.exchange = select_best_exchange(order.symbol);
            
            plan.slices.push_back(slice);
            
            remaining -= slice.quantity;
            current_time += std::chrono::milliseconds(random_delays[i]);
        }
        
        // Handle any remaining quantity
        if (remaining > 0) {
            ExecutionPlan::Slice slice;
            slice.quantity = remaining;
            slice.limit_price = order.price;
            slice.delay = current_time;
            slice.order_type = core::OrderType::LIMIT;
            slice.exchange = select_best_exchange(order.symbol);
            plan.slices.push_back(slice);
        }
        
        plan.total_execution_time = current_time;
        return plan;
    }
    
    [[nodiscard]] ExecutionPlan create_adaptive_plan(
        const core::Order& order, 
        double urgency) const {
        
        // Choose algorithm based on order characteristics
        const double order_size_pct = order.quantity / 100000.0;  // Assume 100k is large
        
        if (urgency > 0.8) {
            return create_sniper_plan(order);
        } else if (order_size_pct > 0.5) {
            return create_stealth_plan(order);
        } else if (urgency < 0.3) {
            return create_vwap_plan(order, urgency);
        } else {
            return create_twap_plan(order, urgency);
        }
    }
    
    void calculate_execution_costs(ExecutionPlan& plan, const core::Order& order) const {
        double total_cost = 0.0;
        double total_slippage = 0.0;
        
        for (const auto& slice : plan.slices) {
            // Look up exchange metrics
            auto it = exchange_metrics_.find(slice.exchange);
            if (it != exchange_metrics_.end()) {
                const auto& metrics = it->second;
                
                // Transaction costs
                const double notional = slice.quantity * slice.limit_price;
                total_cost += notional * metrics.fee_bps / 10000.0;
                
                // Expected slippage
                const double market_impact = calculate_market_impact(
                    slice.quantity, metrics.available_liquidity);
                total_slippage += market_impact;
            }
        }
        
        plan.expected_cost = total_cost;
        plan.expected_slippage_bps = total_slippage / order.quantity * 10000.0;
    }
    
    [[nodiscard]] double calculate_market_impact(
        core::Volume order_size, 
        core::Volume available_liquidity) const {
        
        if (available_liquidity <= 0) return 0.0;
        
        const double participation_rate = order_size / available_liquidity;
        
        // Square-root market impact model
        const double temporary_impact = impact_model_.temporary_impact_coefficient * 
                                      std::sqrt(participation_rate);
        const double permanent_impact = impact_model_.permanent_impact_coefficient * 
                                      participation_rate;
        
        return temporary_impact + permanent_impact;
    }
    
    [[nodiscard]] std::string select_best_exchange(const std::string& symbol) const {
        // In real implementation, would consider symbol-specific liquidity
        std::string best_exchange = "default";
        double best_score = std::numeric_limits<double>::max();
        
        for (const auto& [exchange, metrics] : exchange_metrics_) {
            const double score = metrics.latency_ms + metrics.fee_bps + 
                               (1.0 / (metrics.fill_rate + 0.01));
            if (score < best_score) {
                best_score = score;
                best_exchange = exchange;
            }
        }
        
        return best_exchange;
    }
    
    [[nodiscard]] std::string generate_order_id(const std::string& parent_id) const {
        return parent_id + "_" + std::to_string(order_counter_.fetch_add(1));
    }
};

} // namespace atlas::execution
