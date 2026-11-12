import { IsBooleanString, IsEnum, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { KitchenStation, KitchenStatus } from '@autonex/shared';

export class KdsOrdersQueryDto {
  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsBooleanString()
  includeServed?: string;

  @IsOptional()
  @IsEnum(KitchenStation)
  station?: KitchenStation;
}

export class UpdateKdsStatusDto {
  @IsEnum(KitchenStatus)
  status!: KitchenStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

