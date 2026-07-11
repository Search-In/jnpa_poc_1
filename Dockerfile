# UC-1 Vessel Traffic Management — production image (spec D-1).
# Multi-stage: build the Vite SPA, then serve the static bundle from nginx
# as a non-root user. Air-gap capable: all assets are bundled in the image.

# ---- build stage ----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
# Install deps against the lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Mock mode by default — no credentials required to run.
ENV VITE_DATA_MODE=mock
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
# Serve the built SPA. nginx:alpine already runs worker processes unprivileged;
# we also drop the master to the built-in nginx user and expose an unprivileged
# port so the container can run with --user and no root.
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# Health endpoint + SPA fallback are defined in nginx.conf.
EXPOSE 8080
# Run as the unprivileged nginx user.
USER nginx
CMD ["nginx", "-g", "daemon off;"]
