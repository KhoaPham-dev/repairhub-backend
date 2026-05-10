import cron from 'node-cron';
import { generateRevenueReport, todayVN } from './services/revenueReport';

export function startScheduler(): void {
  // Fires at 00:00 on 1st and 15th of every month (Asia/Ho_Chi_Minh).
  // Each report covers the 14-day window ending the day before firing.
  cron.schedule('0 0 1,15 * *', async () => {
    const periodEnd = todayVN();
    periodEnd.setDate(periodEnd.getDate() - 1); // yesterday in VN time
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 13);
    await generateRevenueReport(periodStart, periodEnd).catch(console.error);
  }, { timezone: 'Asia/Ho_Chi_Minh' });
}
