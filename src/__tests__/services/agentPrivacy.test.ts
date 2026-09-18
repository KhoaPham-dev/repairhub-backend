import { maskFaultDescription } from '../../services/agentPrivacy';

describe('maskFaultDescription', () => {
  it('returns an empty string for null/undefined/empty input', () => {
    expect(maskFaultDescription(null)).toBe('');
    expect(maskFaultDescription(undefined)).toBe('');
    expect(maskFaultDescription('')).toBe('');
  });

  it('leaves plain text with no PII unchanged', () => {
    expect(maskFaultDescription('Loa không lên nguồn, cần kiểm tra mainboard')).toBe(
      'Loa không lên nguồn, cần kiểm tra mainboard'
    );
  });

  it.each([
    ['0912345678', 'plain 10-digit mobile'],
    ['0912 345 678', 'space-separated groups'],
    ['0912.345.678', 'dot-separated groups'],
    ['0912-345-678', 'dash-separated groups'],
    ['+84912345678', 'plus-84 prefix, no spaces'],
    ['+84 912 345 678', 'plus-84 prefix, space-separated'],
    ['84912345678', '84 prefix, no plus'],
  ])('masks a Vietnamese phone number: %s (%s)', (phone) => {
    const masked = maskFaultDescription(`Khách liên hệ ${phone} sau khi sửa xong`);
    expect(masked).toBe('Khách liên hệ [đã ẩn] sau khi sửa xong');
    expect(masked).not.toContain(phone.replace(/[\s.-]/g, ''));
  });

  it('masks an email address', () => {
    const masked = maskFaultDescription('Liên hệ qua email khach@example.com để biết thêm');
    expect(masked).toBe('Liên hệ qua email [đã ẩn] để biết thêm');
  });

  it('masks both a phone number and an email in the same string', () => {
    const masked = maskFaultDescription('SĐT 0912345678 hoặc email khach@example.com');
    expect(masked).toBe('SĐT [đã ẩn] hoặc email [đã ẩn]');
  });

  it('masks multiple phone numbers in the same string', () => {
    const masked = maskFaultDescription('Gọi 0912345678 hoặc 0987654321 nếu không liên lạc được');
    expect(masked).toBe('Gọi [đã ẩn] hoặc [đã ẩn] nếu không liên lạc được');
  });

  it('does not mask a short number that merely starts with 0 or 84', () => {
    // "84 tuổi" (84 years old) — no long digit run following, must not be masked
    expect(maskFaultDescription('Máy đã dùng được 84 tuổi thọ pin')).toBe(
      'Máy đã dùng được 84 tuổi thọ pin'
    );
  });

  it('does not mask an order code or other non-phone digit sequence', () => {
    expect(maskFaultDescription('Đơn liên quan tới mã 20260918')).toBe(
      'Đơn liên quan tới mã 20260918'
    );
  });
});
