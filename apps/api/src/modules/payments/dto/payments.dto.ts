import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '@autonex/shared';

export const MANUAL_PAYMENT_METHODS = [
  PaymentMethod.CASH,
  PaymentMethod.UPI_MANUAL,
  PaymentMethod.CARD,
] as const;

export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

export class RecordManualPaymentDto {
  @IsIn(MANUAL_PAYMENT_METHODS)
  method!: ManualPaymentMethod;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountPaise?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  receiptRef?: string;
}

export class CreateRazorpayOrderDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountPaise?: number;
}

export class VerifyRazorpayPaymentDto {
  @IsString()
  @Length(4, 100)
  razorpayOrderId!: string;

  @IsString()
  @Length(4, 100)
  razorpayPaymentId!: string;

  @IsString()
  @Length(16, 200)
  razorpaySignature!: string;
}

export class ReportPaymentFailureDto {
  @IsString()
  @Length(4, 100)
  razorpayOrderId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  reason?: string;
}

export class CreateRefundDto {
  @IsUUID()
  paymentAttemptId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountPaise?: number;

  @IsString()
  @Length(3, 200)
  reason!: string;
}

