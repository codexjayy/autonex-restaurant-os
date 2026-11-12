import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './common/config/env.validation';
import { TenantContextMiddleware } from './common/context/tenant-context.middleware';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantStatusGuard } from './common/guards/tenant-status.guard';
import { StructuredLoggerService } from './common/logging/structured-logger.service';
import { PrismaModule } from './common/prisma/prisma.module';
import { QueueModule } from './common/queue/queue.module';
import { RealtimeEventsModule } from './common/realtime/realtime-events.module';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { BillingModule } from './modules/billing/billing.module';
import { KitchenModule } from './modules/kitchen/kitchen.module';
import { MenusModule } from './modules/menus/menus.module';
import { OrderingModule } from './modules/ordering/ordering.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { TablesModule } from './modules/tables/tables.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['../../.env', '.env'],
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: Number(config.get<number>('RATE_LIMIT_TTL_SEC') ?? 60) * 1000,
          limit: Number(config.get<number>('RATE_LIMIT_MAX_REQ') ?? 300),
        },
      ],
    }),
    PrismaModule,
    QueueModule.register(),
    RealtimeEventsModule,
    HealthModule,
    AuthModule,
    TenancyModule,
    AdminModule,
    SubscriptionsModule,
    MenusModule,
    TablesModule,
    OrderingModule,
    SessionsModule,
    KitchenModule,
    BillingModule,
    PaymentsModule,
  ],
  providers: [
    StructuredLoggerService,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: TenantStatusGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}

