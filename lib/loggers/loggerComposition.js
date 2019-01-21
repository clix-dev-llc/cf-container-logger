class LoggerComposition {
    constructor(loggers) {
        this.loggers = loggers;
    }
    validate() {
        this.loggers.forEach(logger => {
            logger.validate();
        });
    }
    start () {
        this.loggers.forEach(logger => {
            logger.start();
        });
    }

    attach () {
        this.loggers.forEach(logger => {
            logger.attach();
        });
    }
}
module.exports = LoggerComposition;