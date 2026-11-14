# One image for both backend processes. The API runs by default; the worker
# runs the same image with SERVICE_ROLE=worker (see compose.yaml).
# Build context is the repo root; .dockerignore keeps secrets and builds out.

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# Every workspace manifest must be present for `npm ci` to accept the lockfile,
# but only the backend workspaces are installed and built.
COPY packages/glasses-ui/package.json packages/glasses-ui/
COPY experiments/luna-ikea/app/package.json experiments/luna-ikea/app/
COPY experiments/openrouter-ikea/app/package.json experiments/openrouter-ikea/app/
COPY experiments/openrouter-ikea-v2/app/package.json experiments/openrouter-ikea-v2/app/
COPY packages/server-common packages/server-common
COPY packages/storage packages/storage
COPY packages/db packages/db
COPY apps/api apps/api
COPY apps/worker apps/worker
ENV BACKEND="-w @junction26/server-common -w @junction26/storage -w @junction26/db -w @junction26/worker -w @junction26/api"
RUN npm ci $BACKEND --include-workspace-root \
 && npm run build $BACKEND \
 && npm prune --omit=dev $BACKEND

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/server-common/package.json /app/packages/server-common/
COPY --from=build /app/packages/server-common/dist /app/packages/server-common/dist
COPY --from=build /app/packages/storage/package.json /app/packages/storage/
COPY --from=build /app/packages/storage/dist /app/packages/storage/dist
COPY --from=build /app/packages/db/package.json /app/packages/db/
COPY --from=build /app/packages/db/dist /app/packages/db/dist
COPY --from=build /app/packages/db/migrations /app/packages/db/migrations
COPY --from=build /app/apps/api/package.json /app/apps/api/
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/worker/package.json /app/apps/worker/
COPY --from=build /app/apps/worker/dist /app/apps/worker/dist
COPY scripts/entrypoint.sh /app/entrypoint.sh
USER node
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
