import cron from 'node-cron';
import { generateRevenueReport, todayVN } from './services/revenueReport';

export function startScheduler(): void {
  // Fires at 00:00 on the 1st of every month (Asia/Ho_Chi_Minh).
  // Report covers the full previous month (e.g., on Feb 1st → report for Jan 1–31).
  cron.schedule('0 0 1 * *', async () => {
    const today = todayVN();
    // Last day of previous month = day 0 of current month
    const periodEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    // First day of previous month
    const periodStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    await generateRevenueReport(periodStart, periodEnd).catch(console.error);
  }, { timezone: 'Asia/Ho_Chi_Minh' });
}
