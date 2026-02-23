'use strict';

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
      : undefined,
  base: { service: 'weather-bot' },
});

module.exports = logger;
