import { IsString, IsUUID, Matches } from 'class-validator';

export class StaffPinLoginDto {
  @IsUUID()
  outletId!: string;

  @IsString()
  @Matches(/^\+?[1-9]\d{9,14}$/)
  phone!: string;

  @IsString()
  @Matches(/^\d{4,6}$/)
  pin!: string;
}

