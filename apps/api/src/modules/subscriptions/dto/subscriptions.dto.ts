import {
  IsArray,
  IsBoolean,
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
import {
  SubscriptionBillingCycle,
  SubscriptionStatus,
  SupportCaseCategory,
  SupportCasePriority,
  SupportCaseStatus,
} from '@autonex/shared';

export class CreatePlanDto {
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsInt()
  @Min(0)
  monthlyPricePaise!: number;

  @IsInt()
  @Min(0)
  yearlyPricePaise!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxTables?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxStaff?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxOutlets?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  trialDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  graceDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @IsOptional()
  featuresJson?: unknown;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyPricePaise?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  yearlyPricePaise?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxTables?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxStaff?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxOutlets?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  trialDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  graceDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @IsOptional()
  featuresJson?: unknown;
}

export class AssignSubscriptionDto {
  @IsUUID()
  planId!: string;

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @IsOptional()
  @IsEnum(SubscriptionBillingCycle)
  billingCycle?: SubscriptionBillingCycle;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36)
  durationMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  amountPaiseOverride?: number;

  @IsOptional()
  @IsBoolean()
  recordPaidInvoice?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  paymentReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreateSupportCaseDto {
  @IsString()
  @MinLength(4)
  @MaxLength(160)
  subject!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  description!: string;

  @IsOptional()
  @IsEnum(SupportCaseCategory)
  category?: SupportCaseCategory;

  @IsOptional()
  @IsEnum(SupportCasePriority)
  priority?: SupportCasePriority;

  @IsOptional()
  @IsUUID()
  outletId?: string;
}

export class UpdateSupportCaseDto {
  @IsOptional()
  @IsEnum(SupportCaseStatus)
  status?: SupportCaseStatus;

  @IsOptional()
  @IsEnum(SupportCasePriority)
  priority?: SupportCasePriority;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  resolutionNotes?: string;
}

export class AddSupportNoteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}
