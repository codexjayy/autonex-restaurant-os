import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { StaffRole } from '@autonex/shared';
import { AllowDuringLockOrSettlement } from '../../common/decorators/allow-during-lock.decorator';
import {
  AuthenticatedPrincipal,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CreateRazorpayOrderDto,
  CreateRefundDto,
  RecordManualPaymentDto,
  VerifyRazorpayPaymentDto,
} from './dto/payments.dto';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';

@AllowDuringLockOrSettlement()
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Post('bills/:billId/manual')
  recordManualPayment(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('billId', ParseUUIDPipe) billId: string,
    @Body() dto: RecordManualPaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentsService.recordManualPayment(
      principal,
      billId,
      dto,
      idempotencyKey,
    );
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Post('bills/:billId/razorpay/order')
  createRazorpayOrder(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('billId', ParseUUIDPipe) billId: string,
    @Body() dto: CreateRazorpayOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentsService.createRazorpayOrder(
      principal,
      billId,
      dto,
      idempotencyKey,
    );
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Post('razorpay/verify')
  verifyRazorpayPayment(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: VerifyRazorpayPaymentDto,
  ) {
    return this.paymentsService.verifyRazorpayPayment(principal, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Post('bills/:billId/refunds')
  issueRefund(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('billId', ParseUUIDPipe) billId: string,
    @Body() dto: CreateRefundDto,
  ) {
    return this.paymentsService.issueRefund(principal, billId, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Post('reconcile')
  runManualReconcile(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.reconciliationService.runManualReconcile(principal);
  }
}

