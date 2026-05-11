#!/bin/bash
# 9Router Cloudflare Worker Setup Script
# Run this once to set up your Cloudflare Worker for tunnel registration

set -e

echo "🚀 Setting up 9Router Cloudflare Worker..."

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: wrangler is not installed"
    echo "   Install it with: npm install -g wrangler"
    exit 1
fi

# Check if logged in to Cloudflare
if ! wrangler whoami &> /dev/null; then
    echo "❌ Error: Not logged in to Cloudflare"
    echo "   Login with: wrangler login"
    exit 1
fi

echo "✅ wrangler is ready"

# Create KV namespace
echo "📦 Creating KV namespace..."
KV_ID=$(wrangler kv:namespace create "TUNNEL_KV" 2>&1 | grep -oP '"id"\s*:\s*"\K[^"]+')

if [ -z "$KV_ID" ]; then
    echo "❌ Error: Failed to create KV namespace"
    exit 1
fi

echo "✅ KV namespace created with ID: $KV_ID"

# Update wrangler.toml with KV namespace ID
echo "📝 Updating wrangler.toml..."
cat > wrangler.toml << EOF
name = "9router-tunnel-registration"
main = "tunnel-register.js"
compatibility_date = "2024-01-01"

# Public domain for tunnel URLs (change this to your domain)
[vars]
PUBLIC_DOMAIN = "yourdomain.com"

# KV namespace for storing tunnel mappings
[[kv_namespaces]]
binding = "TUNNEL_KV"
id = "$KV_ID"

# Optional: Configure routing if using custom subdomain
# [routes]
# pattern = "tunnel.yourdomain.com/*"
# zone_name = "yourdomain.com"
EOF

echo "✅ wrangler.toml created"

# Deploy the worker
echo "🚀 Deploying worker..."
wrangler deploy

echo ""
echo "🎉 Setup complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Edit wrangler.toml and set PUBLIC_DOMAIN to your actual domain"
echo "   2. Deploy with: wrangler deploy"
echo "   3. Add route in Cloudflare dashboard if using custom subdomain"
echo "   4. Set PUBLIC_DOMAIN env var in your 9router Docker config:"
echo "      PUBLIC_DOMAIN=yourdomain.com"
echo ""
echo "🔗 Your worker URL will be:"
echo "   https://9router-tunnel-registration.your-subdomain.workers.dev"
echo ""
echo "📚 Documentation: See DOCKER-DEPLOYMENT.md for 9router configuration"