import { TaxMode } from '@autonex/shared';
import { PHONE_REGEX } from '@autonex/validation';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateOutletDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-15 digit phone number' })
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @Length(5, 300)
  address?: string;

  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @Length(3, 60)
  timezone?: string;

  @IsOptional()
  @IsString()
  @Length(10, 20)
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
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsIn(['en', 'gu', 'hi'])
  kdsLanguage?: 'en' | 'gu' | 'hi';

  @IsOptional()
  @IsString()
  @MaxLength(240)
  receiptFooter?: string;
}

