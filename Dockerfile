# ---- stage 1: build the frontend (Node) ----
FROM node:22-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# PWA manifest, service worker, icons: Vite copies public/ into dist/ on build
COPY public ./public
RUN npm run build          # typecheck + emit /build/dist

# ---- stage 2: backend runtime (Python) ----
FROM python:3.11-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install -r backend/requirements.txt
# Bake the static embedding model into the image so conceptual dedup works
# offline at runtime (first load otherwise downloads it). Non-fatal if it fails.
RUN python -c "from model2vec import StaticModel; StaticModel.from_pretrained('minishlab/potion-base-8M')" || true

COPY backend ./backend
# Flask serves the built frontend from <repo-root>/dist (see mesh_api/__init__.py)
COPY --from=frontend /build/dist ./dist

EXPOSE 5000
# Render injects $PORT. One worker by default so first-boot seeding can't race;
# raise WEB_CONCURRENCY once seeding is gated/idempotent.
# --timeout 300 gives a deep calendar backfill room to finish within one request
# (the agent is capped at MESH_AGENT_MAX_STEPS rounds; a deep sync may still need
# a couple of runs — it's idempotent).
CMD ["sh", "-c", "gunicorn --chdir backend wsgi:app --bind 0.0.0.0:${PORT:-5000} --workers ${WEB_CONCURRENCY:-1} --timeout 300"]
