import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ModifyOrderItemLineDto {
  @IsUUID()
  orderItemId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  quantity!: number;
}

export class ModifyOrderItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ModifyOrderItemLineDto)
  items!: ModifyOrderItemLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class SettleSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class CloseSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

