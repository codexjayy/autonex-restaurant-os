import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { BillStatus } from '@autonex/shared';

export class GenerateBillDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  discountPaise?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  discountReason?: string;
}

export class ApplyDiscountDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  discountPaise!: number;

  @IsString()
  @Length(3, 200)
  reason!: string;
}

export class VoidBillDto {
  @IsString()
  @Length(3, 200)
  reason!: string;
}

export class ListBillsQueryDto {
  @IsOptional()
  @IsEnum(BillStatus)
  status?: BillStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

