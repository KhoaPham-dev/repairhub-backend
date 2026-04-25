# RepairHub Backend

Express + TypeScript REST API for the RepairHub management system.

## Stack
- Node.js + Express + TypeScript
- PostgreSQL (raw SQL, no ORM)
- JWT authentication
- bcryptjs password hashing

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your PostgreSQL connection string

# Run migrations (requires psql or run SQL manually)
psql $DATABASE_URL -f migrations/001_initial_schema.sql

npm run dev
```

## Scripts
- `npm run dev` — start with nodemon + ts-node
- `npm run build` — compile TypeScript to dist/
- `npm run typecheck` — type-check without emitting

## API
Base URL: `http://localhost:3001`

- `GET /health` — health check
