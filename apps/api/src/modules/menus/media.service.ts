import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '@autonex/shared';
import sharp from 'sharp';
import { ALLOWED_IMAGE_MIME_TYPES, PresignImageDto } from './dto/presign-image.dto';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_SHARP_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface UploadedImageInput {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface UploadedMediaResult {
  key: string;
  imageUrl: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  contentType: 'image/webp';
  driver: 'local' | 's3';
}

@Injectable()
export class MediaService {
  private readonly driver: 'local' | 's3';
  private readonly cdnBaseUrl: string;
  private readonly localUploadDir: string;
  private readonly s3Bucket: string;
  private readonly s3Client: S3Client | null;

  constructor(private readonly config: ConfigService) {
    this.driver = config.get<'local' | 's3'>('S3_STORAGE_DRIVER') ?? 'local';
    this.cdnBaseUrl = (config.get<string>('CDN_BASE_URL') ?? 'http://localhost:4000/uploads').replace(
      /\/+$/,
      '',
    );
    this.localUploadDir = path.resolve(config.get<string>('LOCAL_UPLOAD_DIR') ?? './uploads');
    this.s3Bucket = config.get<string>('S3_BUCKET') ?? 'autonex-media';

    if (this.driver === 's3') {
      const endpoint = config.get<string>('S3_ENDPOINT');
      const region = config.get<string>('S3_REGION') ?? 'ap-south-1';
      const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID') ?? '';
      const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY') ?? '';

      this.s3Client = new S3Client({
        region,
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        credentials: { accessKeyId, secretAccessKey },
      });
    } else {
      this.s3Client = null;
    }
  }

  /**
   * Validates MIME & actual decoded image header, auto-orients EXIF,
   * resizes within 800x800, converts to WebP, and persists to S3 or local disk.
   */
  async uploadMenuItemImage(
    tenantId: string,
    file: UploadedImageInput | undefined,
  ): Promise<UploadedMediaResult> {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_MEDIA,
        message: 'Image file is required.',
      });
    }

    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_IMAGE_MIME_TYPES)[number])) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_MEDIA,
        message: 'Only JPEG, PNG, and WebP images are supported.',
      });
    }

    if (file.size > MAX_UPLOAD_BYTES || file.buffer.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_MEDIA,
        message: 'Image size must not exceed 5 MB.',
      });
    }

    let processed: { data: Buffer; info: sharp.OutputInfo };
    try {
      const instance = sharp(file.buffer, { failOn: 'error' });
      const metadata = await instance.metadata();
      if (!metadata.format || !ALLOWED_SHARP_FORMATS.has(metadata.format)) {
        throw new Error('Unsupported image format header');
      }

      processed = await instance
        .rotate()
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new BadRequestException({
        code: ErrorCode.INVALID_MEDIA,
        message: 'Uploaded file is not a valid JPEG, PNG, or WebP image.',
      });
    }

    const key = `tenants/${tenantId}/menu/${randomUUID()}.webp`;

    if (this.driver === 's3' && this.s3Client) {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.s3Bucket,
          Key: key,
          Body: processed.data,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } else {
      const targetPath = path.resolve(this.localUploadDir, key);
      if (!targetPath.startsWith(this.localUploadDir + path.sep)) {
        throw new BadRequestException({
          code: ErrorCode.INVALID_MEDIA,
          message: 'Resolved storage path is invalid.',
        });
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, processed.data);
    }

    return {
      key,
      imageUrl: `${this.cdnBaseUrl}/${key}`,
      width: processed.info.width ?? null,
      height: processed.info.height ?? null,
      sizeBytes: processed.data.length,
      contentType: 'image/webp',
      driver: this.driver,
    };
  }

  async createPresignedUploadUrl(tenantId: string, dto: PresignImageDto) {
    const extMap: Record<PresignImageDto['contentType'], string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const key = `tenants/${tenantId}/menu/raw-${randomUUID()}.${extMap[dto.contentType]}`;

    if (this.driver === 's3' && this.s3Client) {
      const command = new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: key,
        ContentType: dto.contentType,
        ContentLength: dto.fileSizeBytes,
      });
      const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn: 300 });
      return {
        driver: 's3' as const,
        method: 'PUT' as const,
        key,
        uploadUrl,
        imageUrl: `${this.cdnBaseUrl}/${key}`,
        expiresInSec: 300,
      };
    }

    return {
      driver: 'local' as const,
      method: 'POST_MULTIPART' as const,
      key,
      uploadUrl: null,
      imageUrl: null,
      endpoint: '/api/v1/menus/images/upload',
      expiresInSec: 300,
    };
  }
}

