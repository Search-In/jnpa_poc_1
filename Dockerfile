# UC-1 Vessel Traffic Management — runtime only (dist from GitHub Actions)
FROM nginx:1.27-alpine

WORKDIR /app

# Create nginx cache directories with proper permissions BEFORE switching to nginx user
RUN mkdir -p /var/cache/nginx/client_temp && \
    chmod 755 /var/cache/nginx && \
    chmod 755 /var/cache/nginx/client_temp && \
    chown -R nginx:nginx /var/cache/nginx

# Copy pre-built SPA from GitHub Actions deployment
COPY dist /usr/share/nginx/html

# Copy nginx configuration
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# Health endpoint + SPA fallback are defined in nginx.conf
EXPOSE 8080

# Run as unprivileged nginx user
USER nginx

CMD ["nginx", "-g", "daemon off;"]