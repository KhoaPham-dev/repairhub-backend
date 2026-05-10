import cron from 'node-cron';
import { generateRevenueReport } from './services/revenueReport';

export function startScheduler(): void {
  // Fires at 00:00 on 1st and 15th of every month (Asia/Ho_Chi_Minh)
  cron.schedule('0 0 1,15 * *', async () => {
    const now = new Date();
    // Compute period: previous 14-day window ending yesterday
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() - 1);
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 13);
    await generateRevenueReport(periodStart, periodEnd).catch(console.error);
  }, { timezone: 'Asia/Ho_Chi_Minh' });
}
