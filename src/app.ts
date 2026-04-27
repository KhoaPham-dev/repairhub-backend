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
import { errorHandler } from './middleware/errorHandler';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads')));

app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/customers', customersRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/warranty', warrantyRouter);
app.use('/api/backup', backupRouter);
app.use('/api/dashboard', dashboardRouter);

app.use(errorHandler);

export default app;
