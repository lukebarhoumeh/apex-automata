// PM2 ecosystem config — Phase 2.5
//
// Wraps `pnpm backend` so a Node crash doesn't end a multi-day paper run.
// PM2 restarts on exit code != 0 with exponential backoff up to max_restarts
// inside restart_delay window. If 10 restarts happen in <5 min the process is
// stopped permanently — that's the "actually broken, page a human" signal,
// not a transient blip.
//
// Install once globally:
//   pnpm add -g pm2
//
// Usage:
//   pm2 start ecosystem.config.cjs --env paper
//   pm2 logs apex-backend
//   pm2 monit
//   pm2 stop apex-backend
//   pm2 delete apex-backend
//
// To survive host reboots:
//   pm2 startup
//   pm2 save

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'apex-backend',
      cwd: path.resolve(__dirname, 'atlas/apps/core-node'),
      script: 'pnpm',
      args: 'api',
      interpreter: 'none',
      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',           // any exit faster than 60s counts toward max_restarts
      restart_delay: 5000,          // 5s between restarts
      exp_backoff_restart_delay: 0, // linear retry — exponential backoff masks repeated crashes during diagnosis
      // Logging
      out_file: path.resolve(__dirname, 'atlas/var/logs/pm2-backend-out.log'),
      error_file: path.resolve(__dirname, 'atlas/var/logs/pm2-backend-err.log'),
      merge_logs: true,
      time: true,
      // Memory guardrail — restart if we leak past 1.5GB
      max_memory_restart: '1500M',
      // Pass-through environment from .env at repo root (PM2 doesn't auto-load
      // dotenv; the backend's own dotenv.config picks up the .env file). We
      // set NODE_ENV explicitly so production-style code paths kick in.
      env: {
        NODE_ENV: 'production',
      },
      env_paper: {
        NODE_ENV: 'production',
        EXECUTION_MODE: 'paper',
      },
    },
  ],
};
