/**
 * 9Router Tunnel Registration Worker
 * 
 * This worker handles tunnel registration from 9router instances.
 * It stores the mapping between shortId and tunnelUrl in Cloudflare KV.
 * 
 * Usage:
 * - POST /api/tunnel/register with { shortId, tunnelUrl }
 * - GET /api/tunnel/:shortId to retrieve tunnel URL
 * - GET /api/tunnel/:shortId/redirect to redirect to tunnel URL
 * 
 * Environment variables:
 * - TUNNEL_KV: KV namespace binding (must be configured in wrangler.toml)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for browser access
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // POST /api/tunnel/register - Register a tunnel
      if (path === '/api/tunnel/register' && request.method === 'POST') {
        const { shortId, tunnelUrl } = await request.json();

        if (!shortId || !tunnelUrl) {
          return JSON.error(400, 'Missing required fields: shortId and tunnelUrl', corsHeaders);
        }

        // Validate shortId format (alphanumeric, 6 chars)
        if (!/^[a-z0-9]{6}$/.test(shortId)) {
          return JSON.error(400, 'Invalid shortId format. Must be 6 alphanumeric characters.', corsHeaders);
        }

        // Validate tunnelUrl is a valid HTTPS URL
        try {
          new URL(tunnelUrl);
        } catch {
          return JSON.error(400, 'Invalid tunnelUrl. Must be a valid URL.', corsHeaders);
        }

        // Store in KV with expiration (tunnels expire after 24 hours by default in cloudflared)
        const key = `tunnel:${shortId}`;
        const value = JSON.stringify({
          tunnelUrl,
          registeredAt: Date.now(),
          expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
        });

        await env.TUNNEL_KV.put(key, value, {
          expirationTtl: 24 * 60 * 60, // 24 hours in seconds
        });

        console.log(`[Tunnel] Registered shortId=${shortId} tunnelUrl=${tunnelUrl}`);

        return JSON.success({ 
          success: true, 
          shortId, 
          tunnelUrl,
          message: 'Tunnel registered successfully'
        }, corsHeaders);
      }

      // GET /api/tunnel/:shortId - Get tunnel info
      const getMatch = path.match(/^\/api\/tunnel\/([a-z0-9]{6})$/i);
      if (getMatch && request.method === 'GET') {
        const shortId = getMatch[1].toLowerCase();
        const key = `tunnel:${shortId}`;

        const data = await env.TUNNEL_KV.get(key, 'json');

        if (!data) {
          return JSON.error(404, 'Tunnel not found or expired', corsHeaders);
        }

        // Check if expired
        if (Date.now() > data.expiresAt) {
          await env.TUNNEL_KV.delete(key);
          return JSON.error(410, 'Tunnel expired', corsHeaders);
        }

        return JSON.success({ 
          shortId, 
          tunnelUrl: data.tunnelUrl,
          registeredAt: data.registeredAt,
          expiresAt: data.expiresAt
        }, corsHeaders);
      }

      // GET /api/tunnel/:shortId/redirect - Redirect to tunnel URL
      const redirectMatch = path.match(/^\/api\/tunnel\/([a-z0-9]{6})\/redirect$/i);
      if (redirectMatch && request.method === 'GET') {
        const shortId = redirectMatch[1].toLowerCase();
        const key = `tunnel:${shortId}`;

        const data = await env.TUNNEL_KV.get(key, 'json');

        if (!data) {
          return new Response('Tunnel not found or expired', { 
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
          });
        }

        // Check if expired
        if (Date.now() > data.expiresAt) {
          await env.TUNNEL_KV.delete(key);
          return new Response('Tunnel expired', { 
            status: 410,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
          });
        }

        return Response.redirect(data.tunnelUrl, 302);
      }

      // GET /api/tunnel/list - List all active tunnels (optional, for admin purposes)
      if (path === '/api/tunnel/list' && request.method === 'GET') {
        const prefix = 'tunnel:';
        const listed = await env.TUNNEL_KV.list({ prefix });

        const tunnels = [];
        for (const key of listed.keys) {
          const data = await env.TUNNEL_KV.get(key.name, 'json');
          if (data && Date.now() < data.expiresAt) {
            tunnels.push({
              shortId: key.name.replace(prefix, ''),
              tunnelUrl: data.tunnelUrl,
              expiresAt: data.expiresAt
            });
          }
        }

        return JSON.success({ tunnels, count: tunnels.length }, corsHeaders);
      }

      // Health check
      if (path === '/api/health' && request.method === 'GET') {
        return JSON.success({ 
          status: 'ok',
          service: '9router tunnel registration worker',
          timestamp: Date.now()
        }, corsHeaders);
      }

      // 404 for unknown routes
      return JSON.error(404, 'Not found', corsHeaders);

    } catch (error) {
      console.error('[Worker] Error:', error);
      return JSON.error(500, `Internal server error: ${error.message}`, corsHeaders);
    }
  }
};

// Helper JSON response object
const JSON = {
  success: (data, headers = {}) => new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' }
  }),
  
  error: (status, message, headers = {}) => new Response(JSON.stringify({ 
    error: true, 
    status, 
    message 
  }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  })
};