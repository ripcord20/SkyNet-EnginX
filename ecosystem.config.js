module.exports = {
  apps: [{
    name: 'isp-netops',
    script: 'backend/server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'development',
      APP_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production',
      APP_ENV: 'production'
    },
    log_file: 'logs/pm2-combined.log',
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    time: true
  }]
};
