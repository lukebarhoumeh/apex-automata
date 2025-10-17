#!/usr/bin/env node

/**
 * AtlasBot v2 Stop Script
 * Cleanly shuts down all running services
 */

const { exec } = require('child_process');
const os = require('os');

const isWindows = os.platform() === 'win32';

console.log('🛑 Stopping AtlasBot v2...\n');

// Kill processes on ports
const ports = [3001, 5173];

if (isWindows) {
  // Windows
  ports.forEach(port => {
    exec(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`, (err) => {
      if (!err) console.log(`✅ Stopped service on port ${port}`);
    });
  });
  
  // Kill named processes
  exec('taskkill /F /FI "WindowTitle eq AtlasBot*" >nul 2>&1', () => {});
} else {
  // Unix/Mac
  ports.forEach(port => {
    exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, (err) => {
      if (!err) console.log(`✅ Stopped service on port ${port}`);
    });
  });
}

setTimeout(() => {
  console.log('\n✅ AtlasBot stopped successfully');
  process.exit(0);
}, 2000);
