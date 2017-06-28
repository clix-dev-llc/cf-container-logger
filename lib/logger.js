'use strict';

const fs                      = require('fs');
const _                       = require('lodash');
const Firebase                = require('firebase');
const Docker                  = require('dockerode');
const DockerEvents            = require('docker-events');
const CFError                 = require('cf-errors');
const logger                  = require('cf-logs').Logger('codefresh:containerLogger');
const ContainerStatus         = require('./enums').ContainerStatus;
const LoggerStrategy          = require('./enums').LoggerStrategy;
const ContainerHandlingStatus = require('./enums').ContainerHandlingStatus;
const ContainerLogger         = require('./ContainerLogger');

class Logger {

    constructor(loggerId, firebaseAuthUrl, firebaseSecret, findExistingContainers) {
        this.state                  = { status: 'init' };
        this.firebaseAuthUrl        = firebaseAuthUrl;
        this.firebaseSecret         = firebaseSecret;
        this.loggerId               = loggerId;
        this.findExistingContainers = findExistingContainers === 'true';
        this.firebaseOptions = {};
        if (process.env.http_proxy){
            this.firebaseOptions.proxy = {origin: process.env.http_proxy};
        }

        let dockerSockPath;
        if (fs.existsSync('/var/run/codefresh/docker.sock')) {
            dockerSockPath = '/var/run/codefresh/docker.sock';
            console.log('Using /var/run/codefresh/docker.sock');
        } else {
            dockerSockPath = '/var/run/docker.sock';
            console.log('Using /var/run/docker.sock');
        }

        this.docker                 = new Docker({
            socketPath: dockerSockPath,
        });
    }

    /**
     * validates the passed params of the constructor
     * @returns {*}
     */
    validate() {
        if (!this.firebaseAuthUrl) {
            return this._error(new CFError('firebase auth url is missing'));
        }
        if (!this.firebaseSecret) {
            return this._error(new CFError('firebase secret is missing'));
        }
        if (!this.loggerId) {
            return this._error(new CFError('logger id is missing'));
        }
    }

    /**
     * main entry point.
     * will attach it self to all created containers that their ids in their labels equals loggerId
     * will attach it self to all existing containers if requested
     * the container label should be 'io.codefresh.loggerId'
     * the path to write the containers logs will be passed through 'io.codefresh.firebaseUrl' label
     * @param loggerId
     * @param firebaseAuthUrl
     * @param firebaseSecret
     */
    start() {

        logger.info(`Logging container created for logger id: ${this.loggerId}`);

        const authRef = new Firebase(this.firebaseAuthUrl);
        authRef.authWithCustomToken(this.firebaseSecret, (err) => {
            if (err) {
                this._error(new CFError({
                    cause: err,
                    message: `Failed to authenticate to firebase url ${this.firebaseAuthUrl}`
                }));
                return;
            }
            logger.info(`Authenticated to firebase url: ${this.firebaseAuthUrl}`);

            this._listenForNewContainers();

            this.state.status = 'ready';
            this._writeNewState();

            if (this.findExistingContainers) {
                this._listenForExistingContainers();
            }

        }, this.firebaseOptions);

    }

    /**
     * will print the error and exit the process
     * @param err
     */
    _error(err) {
        logger.error(err.toString());
        process.exit(1);
    }

    /**
     * will write updates about the attached containers and initial state to a file for future read from isReady.sh script
     * @param state
     */
    _writeNewState() {
        const filePath     = `${__dirname}/state.json`;
        const currentState = JSON.stringify(this.state);
        fs.writeFile(filePath, currentState, (err) => {
            if (err) {
                const error = new CFError({
                    cause: err,
                    message: 'failed to write state to file'
                });
                logger.error(error.toString());
            } else {
                logger.info(`State: ${currentState} updated and written to file: ${filePath}`);
            }
        });
    }

    /**
     * receives a container and decides if to start listening on it
     * @param loggerId
     * @param docker
     * @param newContainer
     */
    _handleContainer(container) {
        const containerId                   = container.Id || container.id;
        const containerStatus               = container.Status || container.status;
        const receivedLoggerId              = _.get(container, 'Labels', _.get(container, 'Actor.Attributes'))['io.codefresh.logger.id'];
        const receivedFirebaseLogsUrl       = _.get(container,
            'Labels',
            _.get(container, 'Actor.Attributes'))['io.codefresh.logger.firebase.logsUrl'];
        const receivedFirebaseLastUpdateUrl = _.get(container,
            'Labels',
            _.get(container, 'Actor.Attributes'))['io.codefresh.logger.firebase.lastUpdateUrl'];
        const loggerStrategy                = _.get(container, 'Labels', _.get(container, 'Actor.Attributes'))['io.codefresh.logger.strategy'];

        if (!containerId) {
            logger.error(`Not handling container because id is missing`);
            return;
        }

        // Validate that we are not already listening on the container
        if (this._containerHandled(containerId)) {
            logger.info(`Not handling container: ${containerId}, status: '${containerStatus}' because this container was already handled previously`);
            return;
        }

        if (!containerStatus) {
            logger.error(`Not handling container: ${containerId}, because this container status is missing`);
            return;
        }

        if (receivedLoggerId !== this.loggerId) {
            logger.info(`Not handling new container: ${containerId}. loggerId label: ${receivedLoggerId}`);
            return;
        }

        if (!receivedFirebaseLogsUrl) {
            logger.error(`Container: ${containerId} does contain a firebaseUrl label`);
            return;
        }

        if (!receivedFirebaseLastUpdateUrl) {
            logger.error(`Container: ${containerId} does contain a loggerFirebaseLastUpdateUrl label`);
            return;
        }

        if (!loggerStrategy) {
            logger.error(`Container: ${containerId} does contain a loggerStrategy label`);
            return;
        }

        if (LoggerStrategy.ALL.indexOf(loggerStrategy) === -1) {
            logger.error(`Container: ${containerId}, loggerStrategy: '${loggerStrategy}' is not supported`);
            return;
        }

        // in case the strategy is LOGS, this means we need to wait for the container to actually start running
        if (containerStatus === ContainerStatus.CREATE && loggerStrategy === LoggerStrategy.LOGS) {
            logger.info(`Not handling container: ${containerId} on '${containerStatus}' status because logging strategy is: ${LoggerStrategy.LOGS} which needs to wait for 'start' status`);
            return;
        }


        this.state[containerId] = { status: ContainerHandlingStatus.INITIALIZING };
        logger.info(`Handling container: ${containerId}, status: '${containerStatus}'`);
        let firebaseLogger;
        try {
            firebaseLogger = new Firebase(receivedFirebaseLogsUrl);
        } catch (err) {
            const error = new CFError({
                cause: err,
                message: `Failed to create a new firebase logger ref`
            });
            logger.error(error.toString());
            return;
        }

        let firebaseLastUpdate;
        try {
            firebaseLastUpdate = new Firebase(receivedFirebaseLastUpdateUrl);
        } catch (err) {
            const error = new CFError({
                cause: err,
                message: `Failed to create a new firebase lastUpdate ref`
            });
            logger.error(error.toString());
            return;
        }

        const containerInterface = this.docker.getContainer(containerId);
        const containerLogger    = new ContainerLogger(containerId, containerInterface, firebaseLogger, firebaseLastUpdate, loggerStrategy);

        containerLogger.start()
            .done(() => {
                this.state[containerId] = { status: ContainerHandlingStatus.LISTENING };
                this._writeNewState();
            }, (err) => {
                const error = new CFError({
                    cause: err,
                    message: `Failed to start logging for container:${containerId}`,
                    containerId
                });
                logger.error(error.toString());
            });
    }

    /**
     * Will check if a container was already handled (no matter what the handling status is)
     * @param containerId
     * @private
     */
    _containerHandled(containerId) {
        return this.state[containerId];
    }

    /**
     * will listen for all new containers
     */
    _listenForNewContainers() {
        const emitter = new DockerEvents({
            docker: this.docker
        });
        emitter.start();
        emitter.on('create', this._handleContainer.bind(this));
        emitter.on('start', this._handleContainer.bind(this));

        logger.info(`Started listening for new containers`);
    }

    /**
     * will listen on all existing containers
     */
    _listenForExistingContainers() {
        logger.info(`Finding existing containers to listen on`);
        this.docker.listContainers((err, containers) => {
            if (err) {
                this._error(new CFError({
                    cause: err,
                    message: `Query of existing containers failed`
                }));
            } else {
                _.forEach(containers, this._handleContainer.bind(this));
            }
        });
    }

}

module.exports = Logger;
