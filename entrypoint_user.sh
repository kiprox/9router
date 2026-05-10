#!/bin/sh
# Fix permission folder volume yang di-mount oleh Coolify
chown -R nextjs:nodejs /app/data /app/data-home 2>/dev/null

# Jalankan perintah (node server.js) sebagai user nextjs
exec su-exec nextjs "$@"