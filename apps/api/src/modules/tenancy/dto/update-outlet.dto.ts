import { TaxMode } from '@autonex/shared';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  Min,
} from 'class-validator';

export class UpdateOutletDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

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
}

