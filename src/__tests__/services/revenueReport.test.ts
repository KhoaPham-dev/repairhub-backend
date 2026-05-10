jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('xlsx', () => ({
  utils: {
    book_new: jest.fn(() => ({})),
    aoa_to_sheet: jest.fn(() => ({})),
    book_append_sheet: jest.fn(),
  },
  writeFile: jest.fn(),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
}));

import { pool } from '../../config/database';
import { generateRevenueReport, todayVN } from '../../services/revenueReport';
import * as XLSX from 'xlsx';
import fs from 'fs';

const mockQuery = pool.query as jest.Mock;
const mockWriteFile = XLSX.writeFile as jest.Mock;
const mockMkdirSync = fs.mkdirSync as jest.Mock;
const mockBookAppendSheet = XLSX.utils.book_append_sheet as jest.Mock;
const mockAoaToSheet = XLSX.utils.aoa_to_sheet as jest.Mock;

const REPORT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const periodStart = new Date('2026-04-01');
const periodEnd = new Date('2026-04-14');
// SQL upper bound is periodEnd + 1 day (inclusive boundary fix)
const queryEndStr = '2026-04-15';

// Reusable detail row fixture
const detailRow = {
  order_code: 'ORD-001',
  status: 'completed',
  fault_description: 'Fast repair',
  created_at: new Date('2026-04-05T10:00:00Z'),
  customer_type: 'individual',
  device_name: 'iPhone 14',
  quotation: '500000',
  customer_name: 'Nguyen Van A',
  phone: '0901234567',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMkdirSync.mockImplementation(() => undefined);
  mockWriteFile.mockImplementation(() => undefined);
  // aoa_to_sheet returns a unique object each call so book_append_sheet gets distinct sheets
  mockAoaToSheet.mockImplementation(() => ({}));
});

describe('todayVN', () => {
  it('returns a Date whose ISO date string matches the current VN local date', () => {
    const result = todayVN();
    const expected = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    expect(result.toISOString().slice(0, 10)).toBe(expected);
  });

  it('returns a Date with time set to midnight UTC (T00:00:00Z)', () => {
    const result = todayVN();
    expect(result.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });
});

describe('generateRevenueReport', () => {
  it('inserts pending row, queries orders (summary + detail), writes Excel, updates to done, returns id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })   // INSERT
      .mockResolvedValueOnce({                                  // SELECT summary
        rows: [
          { status: 'completed', order_count: '10', total_revenue: '5000000' },
          { status: 'pending',   order_count: '3',  total_revenue: '0' },
        ],
      })
      .mockResolvedValueOnce({ rows: [detailRow] })             // SELECT detail
      .mockResolvedValueOnce({ rows: [] });                     // UPDATE done

    const id = await generateRevenueReport(periodStart, periodEnd, 'user-1');

    expect(id).toBe(REPORT_ID);

    // INSERT stores the original periodEnd (not shifted)
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO revenue_reports'),
      ['2026-04-01', '2026-04-14', 'user-1']
    );

    // SELECT summary uses queryEndStr (periodEnd + 1 day) for inclusive upper bound
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM orders'),
      ['2026-04-01', queryEndStr]
    );

    // SELECT detail uses queryEndStr (periodEnd + 1 day) for inclusive upper bound
    expect(mockQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('LEFT JOIN customers'),
      ['2026-04-01', queryEndStr]
    );

    // XLSX.writeFile called once
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // UPDATE to done uses original endStr in filename
    expect(mockQuery).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("status = 'done'"),
      [expect.stringContaining('report-2026-04-01-2026-04-14-'), REPORT_ID]
    );
  });

  it('works without createdBy (null)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const id = await generateRevenueReport(periodStart, periodEnd);
    expect(id).toBe(REPORT_ID);
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ['2026-04-01', '2026-04-14', null]
    );
  });

  it('updates row to failed and rethrows on error', async () => {
    const boom = new Error('db exploded');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })   // INSERT
      .mockRejectedValueOnce(boom)                             // SELECT summary fails
      .mockResolvedValueOnce({ rows: [] });                     // UPDATE failed

    await expect(generateRevenueReport(periodStart, periodEnd, 'user-1')).rejects.toThrow('db exploded');

    expect(mockQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("status = 'failed'"),
      ['db exploded', REPORT_ID]
    );
  });

  it('includes totals row in the summary sheet data', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
      .mockResolvedValueOnce({
        rows: [
          { status: 'done', order_count: '5', total_revenue: '2500000' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await generateRevenueReport(periodStart, periodEnd);

    // First call to aoa_to_sheet is summary sheet
    const summaryData: (string | number)[][] = mockAoaToSheet.mock.calls[0][0];

    // Row 0: period header
    expect(summaryData[0][0]).toMatch(/Kỳ báo cáo/);
    // Row 1: blank
    expect(summaryData[1]).toEqual([]);
    // Row 2: column headers
    expect(summaryData[2]).toEqual(['Trạng thái', 'Số đơn', 'Doanh thu (VNĐ)']);
    // Row 3: data
    expect(summaryData[3]).toEqual(['done', 5, 2500000]);
    // Last row: totals
    const lastRow = summaryData[summaryData.length - 1];
    expect(lastRow[0]).toBe('Tổng cộng');
    expect(lastRow[1]).toBe(5);
    expect(lastRow[2]).toBe(2500000);
  });

  it('creates a second sheet "Chi tiết đơn hàng" with correct headers', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
      .mockResolvedValueOnce({ rows: [] })                     // summary: no rows
      .mockResolvedValueOnce({ rows: [detailRow] })             // detail: one row
      .mockResolvedValueOnce({ rows: [] });

    await generateRevenueReport(periodStart, periodEnd);

    // aoa_to_sheet called twice (summary + detail)
    expect(mockAoaToSheet).toHaveBeenCalledTimes(2);

    // Second call is the detail sheet
    const detailData: (string | number | null)[][] = mockAoaToSheet.mock.calls[1][0];

    // Header row
    expect(detailData[0]).toEqual([
      'Mã đơn', 'Trạng thái', 'Ghi chú', 'Ngày tạo', 'Khách hàng',
      'Loại khách', 'Số điện thoại', 'Thiết bị', 'Báo giá',
    ]);

    // Data row — customer_type 'individual' → 'Cá nhân'
    const dataRow = detailData[1];
    expect(dataRow[0]).toBe('ORD-001');
    expect(dataRow[1]).toBe('completed');
    expect(dataRow[2]).toBe('Fast repair');
    expect(typeof dataRow[3]).toBe('string'); // formatted date string
    expect(dataRow[4]).toBe('Nguyen Van A');
    expect(dataRow[5]).toBe('Cá nhân');
    expect(dataRow[6]).toBe('0901234567');
    expect(dataRow[7]).toBe('iPhone 14');
    expect(dataRow[8]).toBe(500000);
  });

  it('maps customer_type partner → "Đối tác" and unknown → as-is', async () => {
    const partnerRow = { ...detailRow, customer_type: 'partner', order_code: 'ORD-002' };
    const unknownRow = { ...detailRow, customer_type: 'corporate', order_code: 'ORD-003' };

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [partnerRow, unknownRow] })
      .mockResolvedValueOnce({ rows: [] });

    await generateRevenueReport(periodStart, periodEnd);

    const detailData: (string | number | null)[][] = mockAoaToSheet.mock.calls[1][0];
    expect(detailData[1][5]).toBe('Đối tác');
    expect(detailData[2][5]).toBe('corporate');
  });

  it('appends two sheets to the workbook', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await generateRevenueReport(periodStart, periodEnd);

    expect(mockBookAppendSheet).toHaveBeenCalledTimes(2);
    // First sheet name
    expect(mockBookAppendSheet.mock.calls[0][2]).toBe('Báo cáo doanh thu');
    // Second sheet name
    expect(mockBookAppendSheet.mock.calls[1][2]).toBe('Chi tiết đơn hàng');
  });

  describe('inclusive period_end boundary', () => {
    it('uses periodEnd + 1 day as SQL upper bound when periodEnd is today', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStr = today.toISOString().slice(0, 10);

      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().slice(0, 10);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await generateRevenueReport(new Date(today), new Date(today), 'user-1');

      // INSERT stores the original date (todayStr), not the shifted one
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('INSERT INTO revenue_reports'),
        [todayStr, todayStr, 'user-1']
      );

      // Summary query upper bound is tomorrow (inclusive)
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('FROM orders'),
        [todayStr, tomorrowStr]
      );

      // Detail query upper bound is tomorrow (inclusive)
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('LEFT JOIN customers'),
        [todayStr, tomorrowStr]
      );
    });

    it('uses periodEnd + 1 day as SQL upper bound when periodEnd is a past date', async () => {
      const pastEnd = new Date('2025-12-31');
      const pastStart = new Date('2025-12-01');

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await generateRevenueReport(pastStart, pastEnd, 'user-1');

      // INSERT stores original end date
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('INSERT INTO revenue_reports'),
        ['2025-12-01', '2025-12-31', 'user-1']
      );

      // SQL queries use 2026-01-01 (the day after 2025-12-31)
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('FROM orders'),
        ['2025-12-01', '2026-01-01']
      );

      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('LEFT JOIN customers'),
        ['2025-12-01', '2026-01-01']
      );
    });
  });
});
