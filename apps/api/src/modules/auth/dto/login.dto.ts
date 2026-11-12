import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class LoginDto {
  @IsString()
  @Length(4, 160)
  identifier!: string; // Email or phone number

  @IsString()
  @Length(6, 72)
  password!: string;

  @IsOptional()
  @IsUUID()
  outletId?: string;
}

