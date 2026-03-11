-- Phase 2.5: Fix numeric precision in analytics tables
-- DOUBLE PRECISION has floating-point rounding issues for financial data
-- NUMERIC(20,8) provides exact decimal arithmetic

ALTER TABLE trade_outcomes ALTER COLUMN fees TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN realized_pnl TYPE NUMERIC(20,8);
