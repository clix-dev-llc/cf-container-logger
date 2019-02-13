FROM node:10.13.0-alpine

WORKDIR /root/cf-runtime

RUN apk add --no-cache bash git openssh-client tini

COPY package.json ./

COPY yarn.lock ./

# install cf-runtime required binaries
RUN apk add --no-cache --virtual deps python make g++ && \
    yarn install --frozen-lockfile --production && \
    yarn cache clean && \
    apk del deps && \
    rm -rf /tmp/*

# copy app files
COPY . ./

# Set tini as entrypoint
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node",  "node_modules/.bin/forever", "--minUptime",  "1", "--spinSleepTime", "1000", "-c", "node", "lib/index.js"]

