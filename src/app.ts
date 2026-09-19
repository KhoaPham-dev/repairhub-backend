import express from 'express';
import cors from 'cors';
import path from 'path';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import branchesRouter from './routes/branches';
import customersRouter from './routes/customers';
import ordersRouter from './routes/orders';
import warrantyRouter from './routes/warranty';
import backupRouter from './routes/backup';
import dashboardRouter from './routes/dashboard';
import reportsRouter from './routes/reports';
import agentRouter from './routes/agent';
import { errorHandler } from './middleware/errorHandler';
import { startScheduler } from './scheduler';

const app = express();

// Behind nginx, trust that many proxy hops so req.ip (Agent API rate limits
// and request logs) is the real client from X-Forwarded-For rather than the
// proxy's address. Unset/0 keeps Express's default of trusting nothing.
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY ?? '', 10);
if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads'), {
  // Uploaded files (including user-supplied images/videos) are served as-is;
  // prevent browsers from MIME-sniffing them into something more dangerous
  // than the declared Content-Type. Belt-and-suspenders for deployments
  // (e.g. behind a tunnel) where nginx isn't in front adding this itself.
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/customers', customersRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/warranty', warrantyRouter);
app.use('/api/backup', backupRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/agent', agentRouter);

if (process.env.NODE_ENV !== 'test') {
  startScheduler();
}

app.use(errorHandler);

export default app;
