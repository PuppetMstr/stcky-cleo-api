# STCKY API v4.4.0

Serverless API endpoints for Vercel deployment at api.stcky.ai.

## Endpoints

### Core Memory
- `GET/POST/DELETE /api/memory` - CRUD operations
- `GET/POST /api/memory/list` - List by category
- `GET /api/memory/search` - Full-text search
- `GET /api/memory/upcoming` - Time-anchored memories

### Intelligence
- `GET/POST /api/associative` - Temporal NOW scoring (primary recall)
- `GET/POST /api/enrich` - Entity extraction + context retrieval

### Enterprise (v4.4.0)
- `GET/POST/PUT/DELETE /api/projects` - Project-scoped memory
- `GET/POST/PUT/DELETE /api/teams` - Team hierarchy
- `GET/POST/DELETE /api/edges` - Knowledge graph edges (9 types)
- `GET/POST /api/graph` - Graph queries (connections, experts, related)

### Auth
- `GET/POST /api/oauth/authorize` - OAuth 2.0 authorize
- `POST /api/oauth/token` - Token exchange

### Payments
- `POST /api/stripe/checkout` - Stripe checkout session
- `POST /api/stripe/webhook` - Stripe webhook handler
- `POST /api/paypal/checkout` - PayPal subscription
- `POST /api/paypal/webhook` - PayPal webhook handler

### Admin
- `GET /api/admin/users` - List users (requires ADMIN_SECRET)
- `GET /api/admin/email-export` - Export segments for email

### Health
- `GET /api/health` - Status + endpoint list

## Environment Variables

```
MONGODB_URI=mongodb+srv://...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
ADMIN_SECRET=...
```

## Deploy

```bash
vercel --prod
```

## Architecture

```
api/
├── _lib/auth.js      # Shared auth + CORS
├── memory/           # Core CRUD
├── oauth/            # OAuth 2.0
├── admin/            # Admin tools
├── stripe/           # Stripe billing
├── paypal/           # PayPal billing
├── associative.js    # Primary recall
├── enrich.js         # Entity extraction
├── projects.js       # Project scope
├── teams.js          # Team hierarchy
├── edges.js          # Knowledge graph
├── graph.js          # Graph queries
├── sessions.js       # Session tracking
└── health.js         # Status
```

## Collections (MongoDB cleo db)

- `users` - User accounts + billing
- `memories` - Core memory store (+projectId, +createdBy for enterprise)
- `projects` - Project definitions (+teamId)
- `teams` - Team hierarchy (owner > admin > member)
- `edges` - Knowledge graph edges
- `sessions` - Session summaries

## Version History

- **4.4.0** - Enterprise: projects, teams, edges, graph
- **4.3.0** - Temporal NOW Model, associative recall
- **4.2.0** - OAuth, PayPal integration
- **4.1.0** - Stripe billing
- **4.0.0** - Initial serverless architecture
