# Legion's Linux check environment (scripts/linux/check.sh): Node 24 and pnpm, git, the toolchain node-pty compiles
# with, and what Electron needs to run headless under Xvfb.
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 make g++ xvfb xauth \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libdrm2 libatk-bridge2.0-0 libcups2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.1.2

# Chromium refuses to run as root with its sandbox on: work as `node`. The pnpm store is a volume (owned by node).
RUN mkdir -p /home/node/.pnpm-store && chown node:node /home/node/.pnpm-store
USER node
ENV npm_config_store_dir=/home/node/.pnpm-store
RUN git config --global user.name 'Legion Check' && git config --global user.email 'check@legion.invalid' \
    && git config --global init.defaultBranch main
WORKDIR /home/node/legion
