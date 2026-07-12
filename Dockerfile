# UC-1 Vessel Traffic Management — runtime only (dist from GitHub Actions)
FROM nginx:1.27-alpine

WORKDIR /app

# Copy pre-built SPA from GitHub Actions deployment
COPY dist /usr/share/nginx/html

# Copy nginx configuration
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# Health endpoint + SPA fallback are defined in nginx.conf
EXPOSE 8080

# DO NOT use USER nginx - run as root (safe in Docker)
# USER nginx

CMD ["nginx", "-g", "daemon off;"]
