import { StaffRole } from '@autonex/types';
import { PIN_REGEX, PHONE_REGEX } from '@autonex/validation';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SwitchOutletDto {
  @IsUUID()
  outletId!: string;
}

export class CreateInvitationDto {
  @IsOptional()
  @IsUUID()
  outletId?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsString()
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-15 digit phone number' })
  phone!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsEnum(StaffRole)
  role!: StaffRole;
}

export class AcceptInvitationDto {
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password?: string;

  @IsString()
  @Matches(PIN_REGEX, { message: 'PIN must be 4 to 6 digits' })
  pin!: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;
}

