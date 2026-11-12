export interface EnvConfig {
  NODE_ENV: string;
  API_PORT: number;
  CORS_ORIGIN: string;
  APP_URL: string;
  DATABASE_URL: string;
  DATABASE_ADMIN_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ACCESS_TTL: string;
  JWT_REFRESH_TTL_DAYS: number;
  QR_SIGNING_SECRET: string;
  RATE_LIMIT_TTL_SEC: number;
  RATE_LIMIT_MAX_REQ: number;
  S3_STORAGE_DRIVER: 'local' | 's3';
  S3_ENDPOINT?: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  CDN_BASE_URL: string;
  LOCAL_UPLOAD_DIR: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  RAZORPAY_MOCK_MODE: boolean;
  PAYMENT_RECONCILE_STALE_MINUTES: number;
}

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const nodeEnv = String(raw.NODE_ENV ?? 'development');
  const isTest = nodeEnv === 'test';

  const requiredString = (key: string, testFallback?: string): string => {
    const val = raw[key];
    if (typeof val === 'string' && val.trim().length > 0) return val.trim();
    if (isTest && testFallback) return testFallback;
    throw new Error(`Missing required environment variable: ${key}`);
  };

  const optionalString = (key: string): string | undefined => {
    const val = raw[key];
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
  };

  const dbUrl = requiredString(
    'DATABASE_URL',
    'postgresql://autonex_app:autonex_app_pass@localhost:5432/autonex?schema=public',
  );
  const adminDbUrl =
    optionalString('DATABASE_ADMIN_URL') ||
    optionalString('DATABASE_MIGRATION_URL') ||
    dbUrl;

  const storageDriver = raw.S3_STORAGE_DRIVER === 's3' ? 's3' : 'local';
  const s3AccessKeyId = optionalString('S3_ACCESS_KEY_ID');
  const s3SecretAccessKey = optionalString('S3_SECRET_ACCESS_KEY');

  if (storageDriver === 's3' && !isTest && (!s3AccessKeyId || !s3SecretAccessKey)) {
    throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when S3_STORAGE_DRIVER=s3');
  }

  return {
    NODE_ENV: nodeEnv,
    API_PORT: Number(raw.API_PORT ?? 4000),
    CORS_ORIGIN: String(raw.CORS_ORIGIN ?? 'http://localhost:3000'),
    APP_URL: String(raw.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    DATABASE_URL: dbUrl,
    DATABASE_ADMIN_URL: adminDbUrl,
    JWT_ACCESS_SECRET: requiredString('JWT_ACCESS_SECRET', 'test_access_secret_min_32_characters_long_001'),
    JWT_REFRESH_SECRET: requiredString('JWT_REFRESH_SECRET', 'test_refresh_secret_min_32_characters_long_002'),
    JWT_ACCESS_TTL: String(raw.JWT_ACCESS_TTL ?? '15m'),
    JWT_REFRESH_TTL_DAYS: Number(raw.JWT_REFRESH_TTL_DAYS ?? 7),
    QR_SIGNING_SECRET: requiredString(
      'QR_SIGNING_SECRET',
      'test_qr_signing_secret_min_32_characters_long_003',
    ),
    RATE_LIMIT_TTL_SEC: Number(raw.RATE_LIMIT_TTL_SEC ?? 60),
    RATE_LIMIT_MAX_REQ: Number(raw.RATE_LIMIT_MAX_REQ ?? 60),
    S3_STORAGE_DRIVER: storageDriver,
    S3_ENDPOINT: optionalString('S3_ENDPOINT'),
    S3_REGION: String(raw.S3_REGION ?? 'ap-south-1'),
    S3_BUCKET: String(raw.S3_BUCKET ?? 'autonex-media'),
    S3_ACCESS_KEY_ID: s3AccessKeyId,
    S3_SECRET_ACCESS_KEY: s3SecretAccessKey,
    CDN_BASE_URL: String(raw.CDN_BASE_URL ?? 'http://localhost:4000/uploads').replace(/\/+$/, ''),
    LOCAL_UPLOAD_DIR: String(raw.LOCAL_UPLOAD_DIR ?? './uploads'),
    RAZORPAY_KEY_ID: optionalString('RAZORPAY_KEY_ID'),
    RAZORPAY_KEY_SECRET: optionalString('RAZORPAY_KEY_SECRET'),
    RAZORPAY_WEBHOOK_SECRET:
      optionalString('RAZORPAY_WEBHOOK_SECRET') ||
      (isTest ? 'test_razorpay_webhook_secret_32_chars_min' : undefined),
    RAZORPAY_MOCK_MODE:
      raw.RAZORPAY_MOCK_MODE === 'true' ||
      (!optionalString('RAZORPAY_KEY_ID') && nodeEnv !== 'production'),
    PAYMENT_RECONCILE_STALE_MINUTES: Number(raw.PAYMENT_RECONCILE_STALE_MINUTES ?? 2),
  };
}

