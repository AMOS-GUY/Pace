# PACE API image. Build from the repository root:
#   docker build -f infrastructure/docker/api.Dockerfile -t pace-api .
FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @pace/api... \
 && pnpm exec tsc -b packages/domain packages/validation \
 && pnpm --filter @pace/api build \
 && pnpm deploy --filter @pace/api --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/packages/domain/dist ./node_modules/@pace/domain/dist
COPY --from=build /repo/packages/validation/dist ./node_modules/@pace/validation/dist
COPY infrastructure/database/migrations /infrastructure/database/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
