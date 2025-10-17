#!/usr/bin/env node

/**
 * AtlasBot v2 Cross-Platform Startup Script
 * Works on Windows, macOS, and Linux
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

// Platform-specific commands
const isWindows = os.platform() === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const pnpmCmd = isWindows ? 'pnpm.cmd' : 'pnpm';

// Process tracking
let backendProcess = null;
let frontendProcess = null;

// Logging
const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset}  ${msg}`),
  success: (msg) => console.log(`${colors.green}✅${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠️${colors.reset}  ${msg}`),
  error: (msg) => console.log(`${colors.red}❌${colors.reset} ${msg}`),
};

// Create logs directory
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Check if command exists
function commandExists(command) {
  return new Promise((resolve) => {
    const checkCmd = isWindows ? `where ${command}` : `which ${command}`;
    exec(checkCmd, (error) => {
      resolve(!error);
    });
  });
}

// Kill process on port
function killPort(port) {
  return new Promise((resolve) => {
    if (isWindows) {
      exec(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`, () => {
        setTimeout(resolve, 1000);
      });
    } else {
      exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, () => {
        setTimeout(resolve, 1000);
      });
    }
  });
}

// Wait for service to be ready
function waitForService(url, serviceName, maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    
    const check = () => {
      http.get(url, (res) => {
        if (res.statusCode === 200) {
          log.success(`${serviceName} is ready!`);
          resolve();
        } else {
          retry();
        }
      }).on('error', retry);
    };
    
    const retry = () => {
      attempts++;
      if (attempts >= maxAttempts) {
        reject(new Error(`${serviceName} failed to start after ${maxAttempts} attempts`));
      } else {
        setTimeout(check, 1000);
      }
    };
    
    log.info(`Waiting for ${serviceName} to start...`);
    check();
  });
}

// Start a process
function startProcess(command, args, cwd, logFile) {
  const logStream = fs.createWriteStream(path.join(logsDir, logFile));
  
  const proc = spawn(command, args, {
    cwd,
    shell: true,
    detached: false,
  });
  
  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);
  
  proc.on('error', (err) => {
    log.error(`Process error: ${err.message}`);
  });
  
  return proc;
}

// Install dependencies if needed
async function checkAndInstallDeps() {
  log.info('Checking dependencies...');
  
  // Check frontend deps
  if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
    log.warning('Installing frontend dependencies...');
    await new Promise((resolve, reject) => {
      const install = spawn(pnpmCmd, ['install'], { 
        cwd: __dirname, 
        stdio: 'inherit',
        shell: true 
      });
      install.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Failed to install frontend dependencies'));
      });
    });
  }
  
  // Check backend deps
  const backendPath = path.join(__dirname, 'atlas', 'apps', 'core-node');
  if (!fs.existsSync(path.join(backendPath, 'node_modules'))) {
    log.warning('Installing backend dependencies...');
    await new Promise((resolve, reject) => {
      const install = spawn(pnpmCmd, ['install'], { 
        cwd: backendPath, 
        stdio: 'inherit',
        shell: true 
      });
      install.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Failed to install backend dependencies'));
      });
    });
  }
  
  // Build backend if needed
  if (!fs.existsSync(path.join(backendPath, 'dist'))) {
    log.warning('Building backend...');
    await new Promise((resolve, reject) => {
      const build = spawn(pnpmCmd, ['build'], { 
        cwd: backendPath, 
        stdio: 'inherit',
        shell: true 
      });
      build.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Failed to build backend'));
      });
    });
  }
}

// Start the trading engine
async function startTradingEngine() {
  log.info('Starting trading engine in paper mode...');
  
  return new Promise((resolve) => {
    const postData = JSON.stringify({ mode: 'paper' });
    
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: '/api/engine/start',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length,
      },
    };
    
    const req = http.request(options, (res) => {
      if (res.statusCode === 200) {
        log.success('Trading engine started!');
        resolve();
      } else {
        log.error('Failed to start trading engine');
        resolve();
      }
    });
    
    req.on('error', (e) => {
      log.error(`Failed to start trading engine: ${e.message}`);
      resolve();
    });
    
    req.write(postData);
    req.end();
  });
}

// Cleanup function
function cleanup() {
  console.log('\n');
  log.warning('Shutting down AtlasBot...');
  
  if (frontendProcess) {
    frontendProcess.kill();
  }
  
  if (backendProcess) {
    backendProcess.kill();
  }
  
  // Kill processes on ports
  Promise.all([
    killPort(3001),
    killPort(5173),
  ]).then(() => {
    log.success('AtlasBot stopped');
    process.exit(0);
  });
}

// Main startup function
async function start() {
  console.clear();
  console.log('🚀 Starting AtlasBot v2...\n');
  
  try {
    // Check Node.js
    const nodeVersion = process.version;
    log.info(`Node.js version: ${nodeVersion}`);
    
    // Check pnpm
    if (!(await commandExists('pnpm'))) {
      log.warning('Installing pnpm...');
      await new Promise((resolve, reject) => {
        exec(`${npmCmd} install -g pnpm`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    
    // Install dependencies
    await checkAndInstallDeps();
    
    // Free ports
    log.info('Checking ports...');
    await killPort(3001);
    await killPort(5173);
    
    // Start backend
    log.info('Starting backend API...');
    const backendPath = path.join(__dirname, 'atlas', 'apps', 'core-node');
    backendProcess = startProcess(pnpmCmd, ['api'], backendPath, 'backend.log');
    
    // Wait for backend
    await waitForService('http://localhost:3001/health', 'Backend API');
    
    // Start trading engine
    await startTradingEngine();
    
    // Start frontend
    log.info('Starting frontend...');
    frontendProcess = startProcess(pnpmCmd, ['dev'], __dirname, 'frontend.log');
    
    // Wait for frontend
    await waitForService('http://localhost:5173', 'Frontend');
    
    // Success!
    console.log('\n' + colors.green + '═'.repeat(60) + colors.reset);
    console.log(colors.green + '  🎉 AtlasBot v2 is running!' + colors.reset);
    console.log(colors.green + '═'.repeat(60) + colors.reset);
    console.log('\n  📊 Frontend:   http://localhost:5173');
    console.log('  🔧 Backend:    http://localhost:3001');
    console.log('  📝 API Health: http://localhost:3001/health');
    console.log('  📈 Status:     http://localhost:3001/api/status');
    console.log('\n  💡 Tips:');
    console.log('  - Signals start after ~50 minutes of market data');
    console.log('  - Check logs/ folder for detailed output');
    console.log('  - Press Ctrl+C to stop all services');
    console.log('\n' + '═'.repeat(60) + '\n');
    
    // Handle shutdown
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    
    // Keep process alive
    process.stdin.resume();
    
  } catch (error) {
    log.error(`Startup failed: ${error.message}`);
    process.exit(1);
  }
}

// Check if we can use ES modules (for future)
if (require.main === module) {
  start();
}
