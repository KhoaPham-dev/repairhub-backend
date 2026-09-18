/**
 * Tests for logAgentApiStartupStatus (src/routes/agent.ts), the one-time
 * startup warning logged when the Agent API is disabled due to missing/
 * invalid config. Each test loads a fresh copy of the module via
 * jest.isolateModules() so the function's internal "already logged" flag
 * starts unset every time — mirroring the isolate-per-test pattern used
 * elsewhere in this repo for module-load-time state (e.g. orders-upload.test.ts).
 */

function loadFreshAgentModule(): { logAgentApiStartupStatus: () => void } {
  let mod: { logAgentApiStartupStatus: () => void };
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../../routes/agent');
  });
  return mod!;
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.AGENT_API_KEY;
  delete process.env.PUBLIC_MEDIA_BASE_URL;
});

afterEach(() => {
  jest.restoreAllMocks();
  // Only touch the two vars this file itself sets — never reassign
  // process.env wholesale, which (depending on Jest worker/file execution
  // order) can clobber env vars other test files rely on (e.g. UPLOAD_DIR).
  delete process.env.AGENT_API_KEY;
  delete process.env.PUBLIC_MEDIA_BASE_URL;
});

describe('logAgentApiStartupStatus', () => {
  it('logs a warning when both AGENT_API_KEY and PUBLIC_MEDIA_BASE_URL are unset', () => {
    const { logAgentApiStartupStatus } = loadFreshAgentModule();
    logAgentApiStartupStatus();
    expect(console.warn).toHaveBeenCalledTimes(1);
    const message = (console.warn as jest.Mock).mock.calls[0][0] as string;
    expect(message).toContain('AGENT_API_KEY is not set');
    expect(message).toContain('PUBLIC_MEDIA_BASE_URL is not set');
  });

  it('logs a warning naming only the missing piece when AGENT_API_KEY is set but PUBLIC_MEDIA_BASE_URL is not', () => {
    process.env.AGENT_API_KEY = 'a-real-key';
    const { logAgentApiStartupStatus } = loadFreshAgentModule();
    logAgentApiStartupStatus();
    const message = (console.warn as jest.Mock).mock.calls[0][0] as string;
    expect(message).toContain('PUBLIC_MEDIA_BASE_URL is not set');
    expect(message).not.toContain('AGENT_API_KEY is not set');
  });

  it('logs a warning naming only the missing piece when PUBLIC_MEDIA_BASE_URL is set but AGENT_API_KEY is not', () => {
    process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com';
    const { logAgentApiStartupStatus } = loadFreshAgentModule();
    logAgentApiStartupStatus();
    const message = (console.warn as jest.Mock).mock.calls[0][0] as string;
    expect(message).toContain('AGENT_API_KEY is not set');
    expect(message).not.toContain('PUBLIC_MEDIA_BASE_URL is not set');
  });

  it('logs a warning when PUBLIC_MEDIA_BASE_URL is set but not a valid absolute http(s) URL', () => {
    process.env.AGENT_API_KEY = 'a-real-key';
    process.env.PUBLIC_MEDIA_BASE_URL = 'not-a-url';
    const { logAgentApiStartupStatus } = loadFreshAgentModule();
    logAgentApiStartupStatus();
    const message = (console.warn as jest.Mock).mock.calls[0][0] as string;
    expect(message).toContain('PUBLIC_MEDIA_BASE_URL is not a valid absolute http(s) URL');
  });

  it('never includes the AGENT_API_KEY value in the warning', () => {
    process.env.AGENT_API_KEY = 'super-secret-value-12345';
    const { logAgentApiStartupStatus } = loadFreshAgentModule();
    logAgentApiStartupStatus();
    const message = (console.warn as jest.Mock).mock.calls[0][0] as string;
    expect(message).not.toContain('super-secret-value-12345');
  });

  it('does not log when both AGENT_API_KEY and a valid PUBLIC_MEDIA_BASE_URL are set', () => {
    process.env.AGENT_API_KEY = 'a-real-key';
    process.env.PUBLIC_MEDIA_BASE_URL = 'https://media.example.com';
    const { logAgentApiStartupStatus } = loadFreshAgentModule();
    logAgentApiStartupStatus();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('logs at most once even if called multiple times', () => {
    const { logAgentApiStartupStatus } = loadFreshAgentModule();
    logAgentApiStartupStatus();
    logAgentApiStartupStatus();
    logAgentApiStartupStatus();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
