import { StaffRole } from '@autonex/shared';
import { IsBoolean, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CreateStaffDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsString()
  @Matches(/^\+?[1-9]\d{9,14}$/)
  phone!: string;

  @IsEnum(StaffRole)
  role!: StaffRole;

  @IsString()
  @Matches(/^\d{4,6}$/)
  pin!: string;
}

export class UpdateStaffDto {
  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/)
  pin?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

