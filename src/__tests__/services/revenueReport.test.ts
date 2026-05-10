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
import { generateRevenueReport } from '../../services/revenueReport';
import * as XLSX from 'xlsx';
import fs from 'fs';

const mockQuery = pool.query as jest.Mock;
const mockWriteFile = XLSX.writeFile as jest.Mock;
const mockMkdirSync = fs.mkdirSync as jest.Mock;

const REPORT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const periodStart = new Date('2026-04-01');
const periodEnd = new Date('2026-04-14');

beforeEach(() => {
  jest.clearAllMocks();
  mockMkdirSync.mockImplementation(() => undefined);
  mockWriteFile.mockImplementation(() => undefined);
});

describe('generateRevenueReport', () => {
  it('inserts pending row, queries orders, writes Excel, updates to done, returns id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })   // INSERT
      .mockResolvedValueOnce({                                  // SELECT orders
        rows: [
          { status: 'completed', order_count: '10', total_revenue: '5000000' },
          { status: 'pending',   order_count: '3',  total_revenue: '0' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });                     // UPDATE done

    const id = await generateRevenueReport(periodStart, periodEnd, 'user-1');

    expect(id).toBe(REPORT_ID);

    // INSERT called with pending
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO revenue_reports'),
      ['2026-04-01', '2026-04-14', 'user-1']
    );

    // SELECT orders with date range
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM orders'),
      ['2026-04-01', '2026-04-14']
    );

    // XLSX.writeFile called
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    // UPDATE to done
    expect(mockQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("status = 'done'"),
      [expect.stringContaining('report-2026-04-01-2026-04-14.xlsx'), REPORT_ID]
    );
  });

  it('works without createdBy (null)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
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
      .mockRejectedValueOnce(boom)                             // SELECT orders fails
      .mockResolvedValueOnce({ rows: [] });                     // UPDATE failed

    await expect(generateRevenueReport(periodStart, periodEnd, 'user-1')).rejects.toThrow('db exploded');

    expect(mockQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("status = 'failed'"),
      ['db exploded', REPORT_ID]
    );
  });

  it('includes totals row in the sheet data', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: REPORT_ID }] })
      .mockResolvedValueOnce({
        rows: [
          { status: 'done', order_count: '5', total_revenue: '2500000' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await generateRevenueReport(periodStart, periodEnd);

    const aoaToSheet = XLSX.utils.aoa_to_sheet as jest.Mock;
    expect(aoaToSheet).toHaveBeenCalledTimes(1);
    const sheetData: (string | number)[][] = aoaToSheet.mock.calls[0][0];

    // Row 0: period header
    expect(sheetData[0][0]).toMatch(/Kỳ báo cáo/);
    // Row 1: blank
    expect(sheetData[1]).toEqual([]);
    // Row 2: column headers
    expect(sheetData[2]).toEqual(['Trạng thái', 'Số đơn', 'Doanh thu (VNĐ)']);
    // Row 3: data
    expect(sheetData[3]).toEqual(['done', 5, 2500000]);
    // Last row: totals
    const lastRow = sheetData[sheetData.length - 1];
    expect(lastRow[0]).toBe('Tổng cộng');
    expect(lastRow[1]).toBe(5);
    expect(lastRow[2]).toBe(2500000);
  });
});
