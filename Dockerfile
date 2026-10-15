# syntax=docker/dockerfile:1

ARG UV_VERSION=0.11.7
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM node:22-bookworm-slim AS node-lock
WORKDIR /app
COPY package.json package-lock.json ./
# A release version does not change dependencies. Normalize only the root
# version fields so dependency layers survive version-only updates.
RUN node -e 'const fs = require("node:fs"); for (const file of ["package.json", "package-lock.json"]) { const data = JSON.parse(fs.readFileSync(file)); delete data.version; if (data.packages?.[""]) delete data.packages[""].version; fs.writeFileSync(file, JSON.stringify(data)); }'

FROM node:22-bookworm-slim AS node-deps
WORKDIR /app
COPY --from=node-lock /app/package.json /app/package-lock.json ./
RUN --mount=type=cache,id=pudding-npm,target=/root/.npm \
    npm ci --no-audit --no-fund

FROM node-deps AS frontend
COPY package.json ./
COPY index.html vite.config.js ./
COPY frontend ./frontend
COPY shared ./shared
COPY public ./public
RUN npm run build

FROM node-deps AS node-runtime-deps
RUN --mount=type=cache,id=pudding-npm,target=/root/.npm \
    npm prune --omit=dev --no-audit --no-fund

FROM python:3.12-slim-bookworm AS python-base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

FROM python-base AS python-lock
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
# Export locked runtime dependencies without project metadata or dev packages.
RUN uv export --frozen --no-dev --no-emit-project --no-header --no-annotate \
    --output-file=/requirements.txt > /dev/null

FROM python-base AS python-deps
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
ARG UV_DEFAULT_INDEX=https://pypi.org/simple
COPY --from=python-lock /requirements.txt /requirements.txt
RUN --mount=type=cache,id=pudding-uv,target=/root/.cache/uv \
    uv venv --python /usr/local/bin/python /opt/venv \
    && uv pip sync --python /opt/venv/bin/python --require-hashes /requirements.txt

FROM python-base AS hevc-alpha
ARG TARGETARCH
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN --mount=type=cache,id=pudding-apt-cache-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=pudding-apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake nasm pkg-config ca-certificates
WORKDIR /app
COPY scripts/setup-hevc-alpha.py ./scripts/setup-hevc-alpha.py
COPY backend/__init__.py backend/hevc.py ./backend/
RUN --mount=type=cache,id=pudding-hevc-bookworm-${TARGETARCH},target=/var/cache/hevc-alpha,sharing=locked \
    set -eu; \
    hevc_key="$(sha256sum scripts/setup-hevc-alpha.py backend/hevc.py /etc/os-release | sha256sum | cut -d ' ' -f 1)"; \
    hevc_prefix="/var/cache/hevc-alpha/${hevc_key}"; \
    mkdir -p "${hevc_prefix}" /var/cache/hevc-alpha/downloads /out; \
    ln -sfn /var/cache/hevc-alpha/downloads "${hevc_prefix}/downloads"; \
    python scripts/setup-hevc-alpha.py --prefix "${hevc_prefix}"; \
    cp "${hevc_prefix}/bin/ffmpeg" "${hevc_prefix}/bin/ffprobe" /out/

FROM python-base AS runtime
ARG TARGETARCH
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN --mount=type=cache,id=pudding-apt-cache-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=pudding-apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    nodejs ffmpeg fonts-dejavu-core ca-certificates
WORKDIR /app
COPY --from=python-deps /opt/venv /opt/venv
COPY --from=node-runtime-deps /app/node_modules ./node_modules
COPY --from=frontend /app/dist ./dist
COPY --from=hevc-alpha /out/ffmpeg /out/ffprobe /opt/hevc-alpha/bin/
COPY package.json run.py ./
COPY backend ./backend
COPY shared ./shared
COPY scripts/render.mjs ./scripts/render.mjs
COPY examples ./examples
ENV TRACE_DATA_DIR=/app/.data
ENV TRACE_HEVC_FFMPEG_PATH=/opt/hevc-alpha/bin/ffmpeg
ENV PATH="/opt/venv/bin:${PATH}"
EXPOSE 8000
CMD ["python", "run.py", "--host", "0.0.0.0", "--port", "8000"]
