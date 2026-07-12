# UC-1 Vessel Traffic Management — runtime only (dist from GitHub Actions)
FROM nginx:1.27-alpine
WORKDIR /app
# Copy pre-built dist from GitHub Actions
COPY dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
USER nginx
CMD ["nginx", "-g", "daemon off;"]