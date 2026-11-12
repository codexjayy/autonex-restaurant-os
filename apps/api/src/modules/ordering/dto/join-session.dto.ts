import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class OpenTableSessionDto {
  @IsUUID()
  tableId!: string;
}

export class JoinSessionDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'joinCode must be 4 to 6 digits' })
  joinCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  displayLabel?: string;
}

