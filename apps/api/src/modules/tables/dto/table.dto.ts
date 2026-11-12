import { TableStatus } from '@autonex/shared';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateTableDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  tableNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  floorSection?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  capacity?: number;

  @IsOptional()
  @IsEnum(TableStatus)
  status?: TableStatus;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTableDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  tableNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  floorSection?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  capacity?: number;

  @IsOptional()
  @IsEnum(TableStatus)
  status?: TableStatus;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

