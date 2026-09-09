// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'signalbot-engine',
    script: './engine/engine.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 4000,
    },
    env_production: {
      NODE_ENV: 'production',
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    max_memory_restart: '500M',
    restart_delay: 3000,
    kill_timeout: 5000,
    listen_timeout: 3000,
  }, {
    // Unattended walk-forward research + AI model retraining loop.
    // Runs independently of the live trading engine above so it can be
    // stopped/restarted (or crash and auto-restart) without affecting
    // live signals. See docs/AUTO_RESEARCHER.md for configuration.
    name: 'signalbot-researcher',
    script: './engine/auto-researcher.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    env: {
      NODE_ENV: 'production',
    },
    env_production: {
      NODE_ENV: 'production',
    },
    error_file: './logs/researcher-err.log',
    out_file: './logs/researcher-out.log',
    log_file: './logs/researcher-combined.log',
    time: true,
    max_memory_restart: '500M',
    restart_delay: 5000,
    kill_timeout: 10000,
    // The process schedules its own cycles internally (RESEARCH_INTERVAL_HOURS)
    // and stays alive between them, so pm2 only needs to restart it on crash.
    autorestart: true,
  }]
};
