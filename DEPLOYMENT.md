# AtlasBot Deployment & Monitoring Guide

This document covers production deployment and monitoring setup for AtlasBot.

## Architecture Overview

- **Frontend (Web)**: React/Vite app served via Nginx
- **Backend (API)**: Node.js trading engine with WebSocket support
- **Database**: Supabase (Postgres) with Realtime subscriptions
- **Monitoring**: Prometheus + Grafana stack

## Prerequisites

- Docker & Docker Compose
- Kubernetes cluster (EKS/GKE/DO/K3s) - for production
- kubectl configured
- Helm 3.x installed
- Container registry access (ghcr.io, Docker Hub, etc.)

---

## Local Development

### Backend (Node API)
```bash
cd atlas/apps/core-node
pnpm install
pnpm dev  # Starts API server on :3001
```

### Frontend (Web)
```bash
npm install
npm run dev  # Starts Vite dev server
```

---

## Docker Builds

### Build API Image
```bash
docker build -f deploy/docker/Dockerfile.api -t atlas-api:latest .
```

### Build Web Image
```bash
docker build -f deploy/docker/Dockerfile.web -t atlas-web:latest .
```

### Push to Registry
```bash
# Tag with your registry
docker tag atlas-api:latest ghcr.io/YOUR_ORG/atlas-api:$(git rev-parse --short HEAD)
docker tag atlas-web:latest ghcr.io/YOUR_ORG/atlas-web:$(git rev-parse --short HEAD)

# Push
docker push ghcr.io/YOUR_ORG/atlas-api:$(git rev-parse --short HEAD)
docker push ghcr.io/YOUR_ORG/atlas-web:$(git rev-parse --short HEAD)
```

---

## Kubernetes Deployment

### 1. Create Namespace
```bash
kubectl apply -f deploy/k8s/namespace.yaml
```

### 2. Configure Secrets
Edit `deploy/k8s/secret-env.yaml` with your actual values:
```yaml
SUPABASE_URL: "https://gdrdaajvutmewgxbjurk.supabase.co"
SUPABASE_SERVICE_KEY: "your-service-role-key"
SUPABASE_ANON_KEY: "your-anon-key"
ENCRYPTION_KEY: "61610d12777cedb4207951f172e708aace1da3bac19acb5022bd84b563f880f9"
COINBASE_API_KEY: "your-coinbase-key"
COINBASE_API_SECRET: "your-coinbase-secret"
```

Then apply:
```bash
kubectl apply -f deploy/k8s/secret-env.yaml
```

### 3. Deploy Services
```bash
# Deploy API
kubectl apply -f deploy/k8s/api-deployment.yaml
kubectl apply -f deploy/k8s/api-service.yaml

# Deploy Web
kubectl apply -f deploy/k8s/web-deployment.yaml
kubectl apply -f deploy/k8s/web-service.yaml

# Deploy Ingress
kubectl apply -f deploy/k8s/ingress.yaml
```

### 4. Verify Deployment
```bash
kubectl get pods -n atlas-bot
kubectl get svc -n atlas-bot
kubectl logs -f deployment/atlas-api -n atlas-bot
```

---

## Monitoring Setup

### Install Prometheus + Grafana Stack
```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace atlas-bot \
  --create-namespace \
  --set grafana.adminPassword=admin
```

### Access Grafana
```bash
kubectl port-forward -n atlas-bot svc/monitoring-grafana 3000:80
```
Open http://localhost:3000 (admin/admin)

### Configure ServiceMonitor
```bash
kubectl apply -f deploy/monitoring/servicemonitor-api.yaml
```

### Add Supabase Datasource
1. In Grafana, go to Configuration → Data Sources
2. Add PostgreSQL datasource:
   - Host: `gdrdaajvutmewgxbjurk.supabase.co:5432`
   - Database: `postgres`
   - User: `postgres`
   - Password: `<your-supabase-service-key>`
   - SSL Mode: `require`

### Import Dashboard
1. Go to Dashboards → Import
2. Upload `deploy/monitoring/dashboards/trading-overview.json`

### Configure Alerts
```bash
kubectl apply -f deploy/monitoring/alertrules.yaml
```

---

## Environment Variables

### Required for API (Backend)
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_KEY` - Service role key for DB access
- `SUPABASE_ANON_KEY` - Anon key for realtime
- `ENCRYPTION_KEY` - 64-char hex key for secrets encryption
- `CONFIRM_LIVE` - Set to "YES" to enable live trading (default: NO)

### Optional for Live Trading
- `COINBASE_API_KEY` - Coinbase Advanced Trade API key
- `COINBASE_API_SECRET` - Coinbase API secret
- `COINBASE_API_PASSPHRASE` - Coinbase API passphrase (legacy)

### Frontend (Web)
No environment variables needed - uses hardcoded Supabase public config.

---

## Database Migrations

All migrations are in `supabase/migrations/`. To apply:

```bash
# If using Supabase CLI
supabase db push

# Or run SQL directly in Supabase Dashboard
# Go to SQL Editor → paste migration → Run
```

---

## Health Checks

### API Health
```bash
curl http://your-domain.com/api/status
```

Expected response:
```json
{
  "engineRunning": false,
  "mode": "paper",
  "positions": [],
  "riskMetrics": null,
  "activeOrders": []
}
```

### Metrics Endpoint
```bash
curl http://your-domain.com/metrics
```

---

## Troubleshooting

### Backend won't start
1. Check logs: `kubectl logs -f deployment/atlas-api -n atlas-bot`
2. Verify secrets: `kubectl get secret atlas-env -n atlas-bot -o yaml`
3. Check env loading in code: `atlas/apps/core-node/src/core/env.ts`

### WebSocket connection fails
1. Verify ingress supports WebSocket upgrade headers
2. Check `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"`
3. Ensure API service is healthy: `kubectl get pods -n atlas-bot`

### DB connection issues
1. Test from pod: `kubectl exec -it deployment/atlas-api -n atlas-bot -- sh`
2. Run: `psql "postgresql://postgres:$SUPABASE_SERVICE_KEY@gdrdaajvutmewgxbjurk.supabase.co:5432/postgres?sslmode=require"`
3. Check Supabase dashboard for connection limits

### Prometheus not scraping
1. Check ServiceMonitor: `kubectl get servicemonitor -n atlas-bot`
2. Verify Prometheus targets: Prometheus UI → Status → Targets
3. Check API /metrics endpoint is accessible

---

## Production Checklist

- [ ] Update image tags in deployment YAMLs
- [ ] Set strong Grafana admin password
- [ ] Configure ingress TLS/SSL certificates
- [ ] Enable horizontal pod autoscaling (HPA)
- [ ] Set resource limits on deployments
- [ ] Configure backup for Supabase
- [ ] Set up alert routing (Slack/PagerDuty)
- [ ] Enable RLS policies on all tables
- [ ] Rotate encryption keys
- [ ] Set `CONFIRM_LIVE=YES` only when ready
- [ ] Test kill-switch and daily stop mechanisms
- [ ] Configure log aggregation (ELK/Loki)

---

## Metrics Exposed

The API exposes these Prometheus metrics on `/metrics`:

- `atlas_engine_running` - Gauge (1 if running, 0 if stopped)
- `atlas_kill_switch_active` - Gauge (1 if active)
- `atlas_orders_created_total` - Counter
- `atlas_orders_filled_total` - Counter
- Plus default Node.js metrics (CPU, memory, GC, etc.)

---

## Support

For issues:
1. Check logs: `kubectl logs -f deployment/atlas-api -n atlas-bot`
2. Review Grafana dashboards for anomalies
3. Check Supabase logs in dashboard
4. Verify RLS policies allow your operations

See `DATABASE_SCHEMA.md` for DB schema details.
