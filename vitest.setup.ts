/**
 * Integration-test environment.
 *
 * Points every suite at the dedicated `dawaee_test` database and at the
 * recording mock providers, so tests assert on what WOULD have been sent
 * without touching a real network.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://dawaee_app:devpass@127.0.0.1:5433/dawaee_test';
process.env.WORKER_DATABASE_URL ??= 'postgres://dawaee_worker:devpass@127.0.0.1:5433/dawaee_test';
process.env.JWT_SECRET ??= 'test_secret_at_least_thirty_two_characters_long_0123456789';
process.env.IP_HASH_SALT ??= 'test-salt-value';
process.env.OTP_DEBUG_ECHO = 'true';
process.env.LOG_LEVEL ??= 'silent';
process.env.SMS_PROVIDER = 'mock';
process.env.WHATSAPP_PROVIDER = 'mock';
process.env.PUSH_PROVIDER = 'mock';
process.env.OCR_PROVIDER = 'mock';
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_DIR = '/tmp/dawaee-test-storage';
process.env.WORKER_ENABLED = 'false';
