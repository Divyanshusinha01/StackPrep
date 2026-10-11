export interface AppConfig {
  port: number;
  databaseUrl: string;
  rateLimitPerMinute: number;
  gatewayApiKey: string;
  gatewayWebhookSecret: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: required("DATABASE_URL"),
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120),
    gatewayApiKey: required("GATEWAY_API_KEY"),
    gatewayWebhookSecret: required("GATEWAY_WEBHOOK_SECRET"),
  };
}
