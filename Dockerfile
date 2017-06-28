FROM alpine:3.5

# install node
RUN apk add --no-cache nodejs=6.9.5-r0 tini

# set working directory
WORKDIR /app

# copy project file
COPY package.json .

# Build time argument to set NODE_ENV ('production'' by default)
ARG NODE_ENV
ENV NODE_ENV ${NODE_ENV:-production}

# install node packages
RUN apk add --no-cache --virtual .build-dep git && \
    npm set progress=false && \
    npm config set depth 0 && \
    npm install && \
    npm cache clean && \
    apk del .build-dep && \
    rm -rf /tmp/*

# Set tini as entrypoint
COPY . .

# Set tini as entrypoint
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node",  "node_modules/.bin/forever", "--minUptime",  "1", "--spinSleepTime", "1000", "-c", "node", "lib/index.js"]
