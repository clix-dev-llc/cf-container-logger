'use strict';

const path   = require('path');
const cflogs = require('cf-logs');
const LoggerFactory = require('./loggers/loggerFactory');
const LoggerListener = require('./loggerListener');

const loggerOptions = {
    filePath: path.join(__dirname, '../logs', 'logs.log'),
    console: process.env.LOG_TO_CONSOLE || false
};
cflogs.init(loggerOptions);


const loggerImpl = LoggerFactory.getLogger( {
    type: process.env.LOGGER_IMPL || 'firebase',
    firebaseAuthUrl: process.env.FIREBASE_AUTH_URL,
    firebaseSecret: process.env.FIREBASE_SECRET,
    firebaseMetricsLogsUrl: process.env.FIREBASE_METRICS_LOGS_URL,
    redisPath: process.env.REDIS_PATH
}
    
);

const loggerListener = new LoggerListener({
    loggerId: process.env.LOGGER_ID,
    loggerImpl: loggerImpl,
    findExistingContainers: process.env.LISTEN_ON_EXISTING,
    logSizeLimit: process.env.LOG_SIZE_LIMIT ? (parseInt(process.env.LOG_SIZE_LIMIT) * 1000000) : undefined,
});


loggerListener.validate();
loggerListener.start();
