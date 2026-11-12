import { IsOptional, IsString, Length } from 'class-validator';

export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  @Length(16, 512)
  refreshToken?: string;
}

