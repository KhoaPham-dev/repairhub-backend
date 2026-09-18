import dotenv from 'dotenv';
dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is not set. Server will not start.');
  process.exit(1);
}

import app from './app';

const PORT = process.env.PORT || 6061;

const server = app.listen(PORT, () => {
  console.log(`RepairHub API running on port ${PORT}`);
});

// Node 20 defaults requestTimeout to 5 minutes, which can cut off large
// (up to 100MB) video uploads over slow mobile/VPS links. Raise it to 30
// minutes. headersTimeout must stay <= requestTimeout; keep it modest since
// headers alone should arrive quickly even on a slow connection.
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 60 * 1000;
