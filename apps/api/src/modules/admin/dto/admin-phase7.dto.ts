import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SubscriptionBillingCycle,
  SupportCasePriority,
  SupportCaseStatus,
  TenantStatus,
} from '@autonex/shared';

export class OnboardRestaurantDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  restaurantName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  outletName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  ownerName!: string;

  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(20)
  ownerPhone!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  gstin?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2800)
  gstRateBps?: number;

  @IsOptional()
  @IsUUID()
  planId?: string;

  @IsOptional()
  @IsEnum(SubscriptionBillingCycle)
  billingCycle?: SubscriptionBillingCycle;

  @IsOptional()
  @IsBoolean()
  activateImmediately?: boolean;
}

export class ReactivateRestaurantDto {
  @IsOptional()
  @IsString()
  @MaxLength(250)
  reason?: string;

  @IsOptional()
  @IsEnum(TenantStatus)
  targetStatus?: TenantStatus;
}

export class OffboardRestaurantDto {
  @IsString()
  @MinLength(3)
  @MaxLength(250)
  reason!: string;
}

export class ListAuditLogsQueryDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  actorRole?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ListSupportCasesQueryDto {
  @IsOptional()
  @IsEnum(SupportCaseStatus)
  status?: SupportCaseStatus;

  @IsOptional()
  @IsEnum(SupportCasePriority)
  priority?: SupportCasePriority;

  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(250)
  limit?: number;
}

export class ExtendTrialDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days!: number;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  reason?: string;
}

export class MarkInvoicePaidDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  paymentRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  notes?: string;
}

export class ListAdminUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  scope?: 'all' | 'super_admins' | 'tenant_users';

  @IsOptional()
  @IsString()
  @MaxLength(30)
  role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class CreateSuperAdminDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(20)
  phone!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(72)
  password!: string;
}

export class UpdateUserStatusDto {
  @IsBoolean()
  isActive!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  reason?: string;
}

export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  platformName?: string;

  @IsOptional()
  @IsEmail()
  supportEmail?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(20)
  supportPhone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  defaultTrialDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30)
  defaultGraceDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2800)
  saasGstRateBps?: number;

  @IsOptional()
  @IsBoolean()
  autoApproveRegistrations?: boolean;

  @IsOptional()
  @IsBoolean()
  maintenanceMode?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  maintenanceMessage?: string;
}

