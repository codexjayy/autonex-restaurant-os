import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '@autonex/shared';
import type { EnvConfig } from '../../common/config/env.validation';

export interface GatewayOrderResult {
  gatewayOrderId: string;
  keyId: string;
  amountPaise: number;
  currency: 'INR';
  qrPayloadUrl: string;
  isMock: boolean;
}

export interface GatewayPaymentSnapshot {
  id: string;
  order_id: string;
  amount: number;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  error_description?: string | null;
}

export interface GatewayRefundResult {
  gatewayRefundId: string;
  status: 'processed' | 'pending';
}

const MOCK_KEY_ID = 'rzp_test_autonex_mock';
const MOCK_KEY_SECRET = 'mock_razorpay_key_secret_for_dev_tests';

@Injectable()
export class RazorpayClientService {
  private readonly keyId?: string;
  private readonly keySecret?: string;
  private readonly webhookSecret?: string;
  private readonly isMockMode: boolean;

  constructor(private readonly configService: ConfigService<EnvConfig, true>) {
    this.keyId = this.configService.get('RAZORPAY_KEY_ID', { infer: true });
    this.keySecret = this.configService.get('RAZORPAY_KEY_SECRET', { infer: true });
    this.webhookSecret = this.configService.get('RAZORPAY_WEBHOOK_SECRET', { infer: true });
    this.isMockMode = Boolean(this.configService.get('RAZORPAY_MOCK_MODE', { infer: true }));
  }

  getMockModeFlag(): boolean {
    return this.isMockMode || !this.keyId || !this.keySecret;
  }

  private resolveCheckoutSecret(): string | null {
    if (this.keySecret) return this.keySecret;
    if (this.getMockModeFlag()) return MOCK_KEY_SECRET;
    return null;
  }

  private constantTimeHexEquals(expectedHex: string, suppliedHex?: string): boolean {
    if (!suppliedHex || expectedHex.length !== suppliedHex.length) {
      return false;
    }
    try {
      const a = Buffer.from(expectedHex, 'hex');
      const b = Buffer.from(suppliedHex, 'hex');
      return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader?: string): boolean {
    if (!this.webhookSecret || !rawBody || rawBody.length === 0 || !signatureHeader) {
      return false;
    }
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return this.constantTimeHexEquals(expected, signatureHeader.trim());
  }

  verifyCheckoutSignature(
    razorpayOrderId: string,
    razorpayPaymentId: string,
    signatureHex?: string,
  ): boolean {
    const secret = this.resolveCheckoutSecret();
    if (!secret || !razorpayOrderId || !razorpayPaymentId || !signatureHex) {
      return false;
    }
    const expected = createHmac('sha256', secret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
    return this.constantTimeHexEquals(expected, signatureHex.trim());
  }

  computeMockCheckoutSignature(razorpayOrderId: string, razorpayPaymentId: string): string | null {
    if (!this.getMockModeFlag()) return null;
    const secret = this.resolveCheckoutSecret()!;
    return createHmac('sha256', secret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
  }

  private basicAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  async createOrder(params: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrderResult> {
    if (this.getMockModeFlag()) {
      const gatewayOrderId = `order_mock_${randomBytes(6).toString('hex')}`;
      const rupees = (params.amountPaise / 100).toFixed(2);
      const qrPayloadUrl = `upi://pay?pa=autonex@mockupi&pn=AutoNex%20Restaurant&tr=${encodeURIComponent(gatewayOrderId)}&tn=${encodeURIComponent(params.receipt)}&am=${rupees}&cu=INR`;

      return {
        gatewayOrderId,
        keyId: this.keyId || MOCK_KEY_ID,
        amountPaise: params.amountPaise,
        currency: 'INR',
        qrPayloadUrl,
        isMock: true,
      };
    }

    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: params.amountPaise,
        currency: 'INR',
        receipt: params.receipt.slice(0, 40),
        notes: params.notes,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ServiceUnavailableException({
        code: ErrorCode.GATEWAY_ERROR,
        message: `Razorpay order creation failed (${res.status}): ${text.slice(0, 140)}`,
      });
    }

    const data = (await res.json()) as { id: string; amount: number };
    const rupees = (params.amountPaise / 100).toFixed(2);
    return {
      gatewayOrderId: data.id,
      keyId: this.keyId!,
      amountPaise: data.amount,
      currency: 'INR',
      qrPayloadUrl: `upi://pay?pa=merchant@razorpay&pn=AutoNex&tr=${encodeURIComponent(data.id)}&tn=${encodeURIComponent(params.receipt)}&am=${rupees}&cu=INR`,
      isMock: false,
    };
  }

  async fetchOrderPayments(gatewayOrderId: string): Promise<GatewayPaymentSnapshot[]> {
    if (this.getMockModeFlag() || gatewayOrderId.startsWith('order_mock_')) {
      return [];
    }

    const res = await fetch(
      `https://api.razorpay.com/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`,
      {
        method: 'GET',
        headers: {
          Authorization: this.basicAuthHeader(),
        },
      },
    );
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { items?: GatewayPaymentSnapshot[] };
    return Array.isArray(data.items) ? data.items : [];
  }

  async createRefund(
    gatewayPaymentId: string,
    amountPaise: number,
    reason: string,
  ): Promise<GatewayRefundResult> {
    if (this.getMockModeFlag() || gatewayPaymentId.startsWith('pay_mock_')) {
      return {
        gatewayRefundId: `rfnd_mock_${randomBytes(6).toString('hex')}`,
        status: 'processed',
      };
    }

    const res = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(gatewayPaymentId)}/refund`,
      {
        method: 'POST',
        headers: {
          Authorization: this.basicAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountPaise,
          notes: { reason },
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ServiceUnavailableException({
        code: ErrorCode.GATEWAY_ERROR,
        message: `Razorpay refund failed (${res.status}): ${text.slice(0, 140)}`,
      });
    }

    const data = (await res.json()) as { id: string; status?: string };
    return {
      gatewayRefundId: data.id,
      status: data.status === 'processed' ? 'processed' : 'pending',
    };
  }
}

