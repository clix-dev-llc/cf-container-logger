'use strict';

const EventEmitter   = require('events');
const Q              = require('q');
const logger         = require('cf-logs').Logger('codefresh:containerLogger');
const CFError        = require('cf-errors');
const LoggerStrategy = require('./enums').LoggerStrategy;

class ContainerLogger extends EventEmitter {

    constructor({
        containerId,
        containerInterface,
        writter,
        logSizeLimit,
        isWorkflowLogSizeExceeded, // eslint-disable-line
        loggerStrategy
    }) {
        super();
        this.containerId               = containerId;
        this.containerInterface        = containerInterface;
        this.writter                   = writter;
        this.loggerStrategy            = loggerStrategy;
        this.tty                       = false;
        this.logSizeLimit              = logSizeLimit;
        this.logSize                   = 0;
        this.isWorkflowLogSizeExceeded = isWorkflowLogSizeExceeded;
        this.stepFinished              = false;
    }

    start() {
        return Q.ninvoke(this.containerInterface, 'inspect')
            .then((inspectedContainer) => {
                this.tty = inspectedContainer.Config.Tty;
                if (this.loggerStrategy === LoggerStrategy.ATTACH) {
                    return this._getAttachStrategyStream();
                } else if (this.loggerStrategy === LoggerStrategy.LOGS) {
                    return this._getLogsStrategyStream();
                } else {
                    return Q.reject(new CFError(`Strategy: ${this.loggerStrategy} is not supported`));
                }
            })
            .then(([stdout, stderr]) => {
                logger.info(`Attached stream to container: ${this.containerId}`);
                // Listening on the stream needs to be performed different depending if a tty is attached or not
                // See documentation of the docker api here: https://docs.docker.com/engine/reference/api/docker_remote_api_v1.24/#/attach-to-a-container
                if (this.tty) {
                    this._handleTtyStream(stdout, false);
                    if (stderr) {
                        this._handleTtyStream(stderr, true);
                    }
                } else {
                    this._handleNonTtyStream(stdout, false);
                }

                stdout.on('end', () => {
                    this.stepFinished = true;
                    logger.info(`stdout end event was fired for container: ${this.containerId}`);
                });

                if (stderr) {
                    stderr.on('end', () => {
                        this.stepFinished = true;
                        logger.info(`stderr end event was fired for container: ${this.containerId}`);
                    });
                }
            }, (err) => {
                return Q.reject(new CFError({
                    cause: err,
                    message: `Failed to handle container:${this.containerId}`
                }));
            });
    }

    _getAttachStrategyStream() {
        return Q.all([
            Q.ninvoke(this.containerInterface, 'attach', {
                stream: true,
                stdout: true,
                stderr: false,
                tty: true
            }),
            Q.ninvoke(this.containerInterface, 'attach', {
                stream: true,
                stdout: false,
                stderr: true,
                tty: true
            })
        ]);
    }

    _getLogsStrategyStream() {
        return Q.all([
            Q.ninvoke(this.containerInterface, 'logs', {
                follow: 1,
                stdout: 1,
                stderr: 1
            })
        ]);
    }

    _handleTtyStream(stream, isError) {
        stream.on('data', (chunk) => {
            const buf     = new Buffer(chunk);
            const message = buf.toString('utf8');
            this._logMessage(message, isError);
        });
        logger.info(`Listening on stream 'data' event for container: ${this.containerId}`);
    }

    _handleNonTtyStream(stream, isError) {
        stream.on('readable', () => {
            let header = stream.read(8);
            while (header !== null) {
                const payload = stream.read(header.readUInt32BE(4));
                if (payload === null) {
                    break;
                }
                this._logMessage(new Buffer(payload).toString('utf8'), isError);
                header = stream.read(8);
            }
        });
        logger.info(`Listening on stream 'readable' event for container: ${this.containerId}`);
    }

    _stepLogSizeExceeded() {
        return this.logSize > this.logSizeLimit;
    }

    _logMessage(message, isError) {
        if (this.logSizeLimit && (this._stepLogSizeExceeded() || this.isWorkflowLogSizeExceeded()) && !isError) {
            if (!this.logExceededLimitsNotified) {
                this.logExceededLimitsNotified = true;
                message = `\x1B[01;93mLog size exceeded for ${this._stepLogSizeExceeded() ? 'this step' : 'the workflow'}.\nThe step will continue to execute until it finished but new logs will not be stored.\x1B[0m\r\n`;
            } else {
                return;
            }
        }

        if (isError) {
            message = `\x1B[31m${message}\x1B[0m`;
        }

        this.writter.push(message);
        this.writter.setLastUpdate(new Date().getTime());

        if (this.logSizeLimit) {
            this.logSize += Buffer.byteLength(message);
            this.writter.updateMetric('total', this.logSize);
        }
        this.emit('message.logged');
    }

}

module.exports = ContainerLogger;
