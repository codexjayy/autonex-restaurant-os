import { DietaryType, KitchenStation, SelectionType, TaxMode } from '@autonex/shared';
import { Transform, Type } from 'class-transformer';

function toOptionalNullableInt({ value }: { value: unknown }) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return Number(value);
}
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ModifierOptionInputDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(-500000)
  @Max(500000)
  priceDeltaPaise!: number;

  @IsOptional()
  @IsBoolean()
  inStock?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class ModifierGroupInputDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @IsEnum(SelectionType)
  selectionType!: SelectionType;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  minSelect?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  maxSelect?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ModifierOptionInputDto)
  options!: ModifierOptionInputDto[];
}

export class CreateMenuItemDto {
  @IsUUID()
  categoryId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  @IsOptional()
  @IsEnum(DietaryType)
  dietaryType?: DietaryType;

  @IsOptional()
  @IsEnum(KitchenStation)
  kitchenStation?: KitchenStation;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000000)
  basePricePaise!: number;

  @IsOptional()
  @Transform(toOptionalNullableInt)
  @IsInt()
  @Min(1)
  @Max(240)
  prepTimeMinutes?: number | null;

  @IsOptional()
  @Transform(toOptionalNullableInt)
  @IsInt()
  @Min(0)
  @Max(2800)
  gstRateBps?: number | null;

  @IsOptional()
  @IsEnum(TaxMode)
  taxMode?: TaxMode | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^$|^https?:\/\/.+/i, {
    message: 'imageUrl must be an empty string or http(s) URL',
  })
  imageUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  inStock?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModifierGroupInputDto)
  modifierGroups?: ModifierGroupInputDto[];
}

export class UpdateMenuItemDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string | null;

  @IsOptional()
  @IsEnum(DietaryType)
  dietaryType?: DietaryType;

  @IsOptional()
  @IsEnum(KitchenStation)
  kitchenStation?: KitchenStation;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000000)
  basePricePaise?: number;

  @IsOptional()
  @Transform(toOptionalNullableInt)
  @IsInt()
  @Min(1)
  @Max(240)
  prepTimeMinutes?: number | null;

  @IsOptional()
  @Transform(toOptionalNullableInt)
  @IsInt()
  @Min(0)
  @Max(2800)
  gstRateBps?: number | null;

  @IsOptional()
  @IsEnum(TaxMode)
  taxMode?: TaxMode | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^$|^https?:\/\/.+/i, {
    message: 'imageUrl must be an empty string or http(s) URL',
  })
  imageUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  inStock?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModifierGroupInputDto)
  modifierGroups?: ModifierGroupInputDto[];
}

