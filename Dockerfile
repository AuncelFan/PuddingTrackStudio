FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY frontend ./frontend
COPY shared ./shared
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM python:3.12-slim-bookworm AS hevc-alpha
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake nasm pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/setup-hevc-alpha.py ./scripts/setup-hevc-alpha.py
COPY backend/__init__.py backend/hevc.py ./backend/
RUN python scripts/setup-hevc-alpha.py --prefix /opt/hevc-alpha

FROM python:3.12-slim-bookworm
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends nodejs ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY --from=frontend /app/node_modules ./node_modules
COPY --from=frontend /app/dist ./dist
COPY --from=hevc-alpha /opt/hevc-alpha/bin/ffmpeg /opt/hevc-alpha/bin/ffprobe /opt/hevc-alpha/bin/
COPY package.json run.py ./
COPY backend ./backend
COPY shared ./shared
COPY scripts/render.mjs ./scripts/render.mjs
COPY examples ./examples
ENV TRACE_DATA_DIR=/app/.data
ENV TRACE_HEVC_FFMPEG_PATH=/opt/hevc-alpha/bin/ffmpeg
EXPOSE 8000
CMD ["uv", "run", "--no-sync", "python", "run.py", "--host", "0.0.0.0", "--port", "8000"]
