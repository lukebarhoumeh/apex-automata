#include <napi.h>
#include <memory>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <queue>
#include <mutex>
#include <condition_variable>

// Include our C++ trading engine headers
#include "atlas/strategies/scalping_strategy.hpp"
#include "atlas/strategies/arbitrage_strategy.hpp"
#include "atlas/ml/feature_engineering.hpp"
#include "atlas/execution/smart_order_router.hpp"

using namespace atlas;

// Thread-safe message queue for async communication
template<typename T>
class ThreadSafeQueue {
private:
    mutable std::mutex mutex_;
    std::queue<T> queue_;
    std::condition_variable cv_;
    
public:
    void push(T value) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            queue_.push(std::move(value));
        }
        cv_.notify_one();
    }
    
    bool try_pop(T& value) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (queue_.empty()) return false;
        value = std::move(queue_.front());
        queue_.pop();
        return true;
    }
    
    void wait_and_pop(T& value) {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [this] { return !queue_.empty(); });
        value = std::move(queue_.front());
        queue_.pop();
    }
};

// Native trading engine wrapper
class TradingEngineWrapper : public Napi::ObjectWrap<TradingEngineWrapper> {
private:
    // Strategy instances
    std::unique_ptr<strategies::ScalpingStrategy> scalping_strategy_;
    std::unique_ptr<strategies::ArbitrageStrategy> arbitrage_strategy_;
    std::unique_ptr<ml::FeatureEngineering> feature_engine_;
    std::unique_ptr<execution::SmartOrderRouter> smart_router_;
    
    // Processing thread
    std::unique_ptr<std::thread> processing_thread_;
    std::atomic<bool> running_{false};
    
    // Message queues
    ThreadSafeQueue<core::MarketData> market_data_queue_;
    ThreadSafeQueue<core::Signal> signal_queue_;
    
    // Callbacks
    Napi::ThreadSafeFunction signal_callback_;
    Napi::ThreadSafeFunction order_callback_;
    
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "TradingEngine", {
            InstanceMethod("initialize", &TradingEngineWrapper::Initialize),
            InstanceMethod("processMarketData", &TradingEngineWrapper::ProcessMarketData),
            InstanceMethod("updateExchangeMetrics", &TradingEngineWrapper::UpdateExchangeMetrics),
            InstanceMethod("getFeatures", &TradingEngineWrapper::GetFeatures),
            InstanceMethod("routeOrder", &TradingEngineWrapper::RouteOrder),
            InstanceMethod("shutdown", &TradingEngineWrapper::Shutdown),
            InstanceMethod("getStats", &TradingEngineWrapper::GetStats)
        });
        
        Napi::FunctionReference* constructor = new Napi::FunctionReference();
        *constructor = Napi::Persistent(func);
        env.SetInstanceData(constructor);
        
        exports.Set("TradingEngine", func);
        return exports;
    }
    
    TradingEngineWrapper(const Napi::CallbackInfo& info) 
        : Napi::ObjectWrap<TradingEngineWrapper>(info) {}
    
    ~TradingEngineWrapper() {
        Shutdown(Napi::CallbackInfo(nullptr, nullptr));
    }
    
private:
    // Initialize the trading engine with configuration
    Napi::Value Initialize(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        if (info.Length() < 2) {
            Napi::TypeError::New(env, "Expected config object and callbacks").ThrowAsJavaScriptException();
            return env.Null();
        }
        
        try {
            Napi::Object config = info[0].As<Napi::Object>();
            Napi::Object callbacks = info[1].As<Napi::Object>();
            
            // Initialize strategies with config
            strategies::ScalpingStrategy::Config scalping_config;
            if (config.Has("scalping")) {
                auto scalping = config.Get("scalping").As<Napi::Object>();
                scalping_config.min_spread_bps = scalping.Get("minSpreadBps").As<Napi::Number>().DoubleValue();
                scalping_config.profit_target_bps = scalping.Get("profitTargetBps").As<Napi::Number>().DoubleValue();
                scalping_config.stop_loss_bps = scalping.Get("stopLossBps").As<Napi::Number>().DoubleValue();
            }
            scalping_strategy_ = std::make_unique<strategies::ScalpingStrategy>(scalping_config);
            
            // Initialize other components
            arbitrage_strategy_ = std::make_unique<strategies::ArbitrageStrategy>();
            feature_engine_ = std::make_unique<ml::FeatureEngineering>(1000);
            smart_router_ = std::make_unique<execution::SmartOrderRouter>();
            
            // Set up callbacks
            signal_callback_ = Napi::ThreadSafeFunction::New(
                env,
                callbacks.Get("onSignal").As<Napi::Function>(),
                "SignalCallback",
                0,
                1
            );
            
            order_callback_ = Napi::ThreadSafeFunction::New(
                env,
                callbacks.Get("onOrder").As<Napi::Function>(),
                "OrderCallback",
                0,
                1
            );
            
            // Start processing thread
            running_ = true;
            processing_thread_ = std::make_unique<std::thread>(&TradingEngineWrapper::ProcessingLoop, this);
            
            return Napi::Boolean::New(env, true);
            
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
            return env.Null();
        }
    }
    
    // Process incoming market data
    Napi::Value ProcessMarketData(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        if (info.Length() < 1 || !info[0].IsObject()) {
            Napi::TypeError::New(env, "Expected market data object").ThrowAsJavaScriptException();
            return env.Null();
        }
        
        try {
            Napi::Object data = info[0].As<Napi::Object>();
            
            core::MarketData market_data;
            market_data.symbol = data.Get("symbol").As<Napi::String>().Utf8Value();
            market_data.timestamp = std::chrono::system_clock::now();
            market_data.bid = data.Get("bid").As<Napi::Number>().DoubleValue();
            market_data.ask = data.Get("ask").As<Napi::Number>().DoubleValue();
            market_data.last = data.Get("last").As<Napi::Number>().DoubleValue();
            market_data.bid_size = data.Get("bidSize").As<Napi::Number>().DoubleValue();
            market_data.ask_size = data.Get("askSize").As<Napi::Number>().DoubleValue();
            market_data.last_size = data.Get("lastSize").As<Napi::Number>().DoubleValue();
            
            // Queue for processing
            market_data_queue_.push(market_data);
            
            return Napi::Boolean::New(env, true);
            
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
            return env.Null();
        }
    }
    
    // Update exchange routing metrics
    Napi::Value UpdateExchangeMetrics(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        if (info.Length() < 2) {
            Napi::TypeError::New(env, "Expected exchange name and metrics").ThrowAsJavaScriptException();
            return env.Null();
        }
        
        try {
            std::string exchange = info[0].As<Napi::String>().Utf8Value();
            Napi::Object metrics = info[1].As<Napi::Object>();
            
            execution::SmartOrderRouter::RouteMetrics route_metrics;
            route_metrics.exchange = exchange;
            route_metrics.latency_ms = metrics.Get("latencyMs").As<Napi::Number>().DoubleValue();
            route_metrics.fill_rate = metrics.Get("fillRate").As<Napi::Number>().DoubleValue();
            route_metrics.fee_bps = metrics.Get("feeBps").As<Napi::Number>().DoubleValue();
            
            smart_router_->update_metrics(exchange, route_metrics);
            
            return Napi::Boolean::New(env, true);
            
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
            return env.Null();
        }
    }
    
    // Get current features for ML model
    Napi::Value GetFeatures(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        try {
            auto features = feature_engine_->extract_features();
            
            Napi::Array result = Napi::Array::New(env, features.size());
            for (size_t i = 0; i < features.size(); ++i) {
                result[i] = Napi::Number::New(env, features[i]);
            }
            
            return result;
            
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
            return env.Null();
        }
    }
    
    // Route an order using smart order router
    Napi::Value RouteOrder(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        if (info.Length() < 2) {
            Napi::TypeError::New(env, "Expected order and market data").ThrowAsJavaScriptException();
            return env.Null();
        }
        
        try {
            Napi::Object order_obj = info[0].As<Napi::Object>();
            Napi::Object market_data_obj = info[1].As<Napi::Object>();
            
            // Parse order
            core::Order order;
            order.id = order_obj.Get("id").As<Napi::String>().Utf8Value();
            order.symbol = order_obj.Get("symbol").As<Napi::String>().Utf8Value();
            order.side = order_obj.Get("side").As<Napi::String>().Utf8Value() == "buy" ? 
                        core::Side::BUY : core::Side::SELL;
            order.quantity = order_obj.Get("quantity").As<Napi::Number>().DoubleValue();
            order.price = order_obj.Get("price").As<Napi::Number>().DoubleValue();
            
            // Parse market data
            std::unordered_map<std::string, core::MarketData> market_data_map;
            Napi::Array exchanges = market_data_obj.GetPropertyNames();
            
            for (uint32_t i = 0; i < exchanges.Length(); ++i) {
                std::string exchange = exchanges.Get(i).As<Napi::String>().Utf8Value();
                Napi::Object data = market_data_obj.Get(exchange).As<Napi::Object>();
                
                core::MarketData md;
                md.symbol = order.symbol;
                md.bid = data.Get("bid").As<Napi::Number>().DoubleValue();
                md.ask = data.Get("ask").As<Napi::Number>().DoubleValue();
                md.bid_size = data.Get("bidSize").As<Napi::Number>().DoubleValue();
                md.ask_size = data.Get("askSize").As<Napi::Number>().DoubleValue();
                
                market_data_map[exchange] = md;
            }
            
            // Route order
            auto routed_orders = smart_router_->route_order_adaptive(order, market_data_map);
            
            // Convert result
            Napi::Array result = Napi::Array::New(env, routed_orders.size());
            for (size_t i = 0; i < routed_orders.size(); ++i) {
                const auto& [exchange, routed_order] = routed_orders[i];
                
                Napi::Object order_result = Napi::Object::New(env);
                order_result.Set("exchange", exchange);
                order_result.Set("orderId", routed_order.id);
                order_result.Set("quantity", routed_order.quantity);
                order_result.Set("price", routed_order.price);
                
                result[i] = order_result;
            }
            
            return result;
            
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
            return env.Null();
        }
    }
    
    // Shutdown the engine
    Napi::Value Shutdown(const Napi::CallbackInfo& info) {
        running_ = false;
        
        if (processing_thread_ && processing_thread_->joinable()) {
            // Push dummy data to wake up thread
            market_data_queue_.push({});
            processing_thread_->join();
        }
        
        if (signal_callback_) {
            signal_callback_.Release();
        }
        if (order_callback_) {
            order_callback_.Release();
        }
        
        return info.Env().Undefined();
    }
    
    // Get engine statistics
    Napi::Value GetStats(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        
        Napi::Object stats = Napi::Object::New(env);
        stats.Set("queueSize", Napi::Number::New(env, 0)); // Would track actual queue sizes
        stats.Set("signalsGenerated", Napi::Number::New(env, 0)); // Would track signals
        
        return stats;
    }
    
    // Background processing thread
    void ProcessingLoop() {
        while (running_) {
            core::MarketData data;
            market_data_queue_.wait_and_pop(data);
            
            if (!running_) break;
            if (data.symbol.empty()) continue;
            
            // Update feature engine
            feature_engine_->add_tick(data);
            
            // Check for scalping signals
            auto scalping_signal = scalping_strategy_->process_tick(data);
            if (scalping_signal.has_value()) {
                EmitSignal(scalping_signal.value());
            }
            
            // Update arbitrage strategy
            strategies::ArbitrageStrategy::ExchangeQuote quote{
                .exchange = "primary",
                .bid = data.bid,
                .ask = data.ask,
                .bid_size = data.bid_size,
                .ask_size = data.ask_size,
                .timestamp = data.timestamp,
                .latency_ms = 1.0
            };
            arbitrage_strategy_->update_quote(data.symbol, quote);
            
            // Check for arbitrage opportunities
            auto arb_opportunities = arbitrage_strategy_->find_opportunities();
            for (const auto& opp : arb_opportunities) {
                // Convert to signal
                core::Signal signal{
                    .symbol = opp.symbol,
                    .direction = core::Side::BUY,
                    .entry_price = opp.buy_price,
                    .stop_loss = opp.buy_price * 0.999,
                    .take_profit = opp.sell_price,
                    .strength = 1.0 - opp.execution_risk_score,
                    .strategy = "arbitrage",
                    .timestamp = std::chrono::system_clock::now()
                };
                EmitSignal(signal);
            }
        }
    }
    
    // Emit signal to JavaScript
    void EmitSignal(const core::Signal& signal) {
        auto callback = [](Napi::Env env, Napi::Function jsCallback, core::Signal* signal) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("symbol", signal->symbol);
            obj.Set("direction", signal->direction == core::Side::BUY ? "buy" : "sell");
            obj.Set("entryPrice", signal->entry_price);
            obj.Set("stopLoss", signal->stop_loss);
            obj.Set("takeProfit", signal->take_profit);
            obj.Set("strength", signal->strength);
            obj.Set("strategy", signal->strategy);
            
            jsCallback.Call({obj});
            delete signal;
        };
        
        signal_callback_.BlockingCall(new core::Signal(signal), callback);
    }
};

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    TradingEngineWrapper::Init(env, exports);
    return exports;
}

NODE_API_MODULE(trading_engine, Init)
