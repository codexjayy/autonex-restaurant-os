import { TaxMode } from '@autonex/shared';
import { PHONE_REGEX } from '@autonex/validation';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  locale?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  defaultTimezone?: string;

  @IsOptional()
  @IsBoolean()
  onboardingCompleted?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  onboardingStep?: number;
}

export class CreateOutletDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-15 digit phone number' })
  contactPhone!: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(20)
  gstin?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2800)
  gstRateBps?: number;

  @IsOptional()
  @IsEnum(TaxMode)
  taxMode?: TaxMode;

  @IsOptional()
  @IsBoolean()
  roundOffEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  requireWaiterApproval?: boolean;

  @IsOptional()
  @IsBoolean()
  tablePinEnabled?: boolean;

  @IsOptional()
  @IsIn(['en', 'gu', 'hi'])
  kdsLanguage?: 'en' | 'gu' | 'hi';

  @IsOptional()
  @IsString()
  @MaxLength(240)
  receiptFooter?: string;
}

