import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class ApproveTenantDto {
  @IsOptional()
  @IsIn(['TRIAL', 'ACTIVE'])
  targetStatus?: 'TRIAL' | 'ACTIVE';

  @IsOptional()
  @IsString()
  @Length(2, 200)
  note?: string;
}

export class SuspendTenantDto {
  @IsString()
  @Length(5, 300)
  reason!: string;
}

