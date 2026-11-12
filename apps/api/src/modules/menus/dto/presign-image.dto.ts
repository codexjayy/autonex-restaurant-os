import { Type } from 'class-transformer';
import { IsIn, IsInt, Max, Min } from 'class-validator';

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export class PresignImageDto {
  @IsIn(ALLOWED_IMAGE_MIME_TYPES)
  contentType!: (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5 * 1024 * 1024)
  fileSizeBytes!: number;
}

