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
  }]
};
