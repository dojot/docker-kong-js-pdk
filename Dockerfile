FROM kong:2.8.1-alpine

USER root
RUN apk add --update bash \
  g++ \
  npm \
  python3 \
  lz4-dev \
  musl-dev \
  cyrus-sasl-dev \
  openssl-dev \
  make \  
  && rm -rf /var/cache/apk/*

RUN apk add --no-cache --virtual .build-deps \
    gcc \
    zlib-dev \
    libc-dev \
    bsd-compat-headers \
    py-setuptools \
    bash
RUN node --version

RUN npm install --unsafe -g kong-pdk@0.5.3

COPY ./config /etc/kong/declarative
COPY ./plugins/js-plugins/keycloak-plugin.js /usr/local/kong/js-plugins/keycloak-plugin.js
COPY ./plugins/js-plugins/package.json /usr/local/kong/js-plugins/package.json

WORKDIR /usr/local/kong/js-plugins/
RUN npm install --omit=dev
