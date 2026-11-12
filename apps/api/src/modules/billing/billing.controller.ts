import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { StaffRole } from '@autonex/shared';
import type { Response } from 'express';
import { AllowDuringLockOrSettlement } from '../../common/decorators/allow-during-lock.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  ApplyDiscountDto,
  GenerateBillDto,
  ListBillsQueryDto,
  VoidBillDto,
} from './dto/billing.dto';
import { BillingService } from './billing.service';

@AllowDuringLockOrSettlement()
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Get('bills')
  listOutletBills(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query() query: ListBillsQueryDto,
  ) {
    return this.billingService.listOutletBills(principal, query);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Get('analytics')
  getBillingAnalytics(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.billingService.getBillingAnalytics(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Get('bills/:id')
  getBill(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) billId: string,
  ) {
    return this.billingService.getBill(principal, billId);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Get('bills/:id/audit')
  getBillAuditLogs(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) billId: string,
  ) {
    return this.billingService.getBillAuditLogs(principal, billId);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Get('sessions/:sessionId/bill')
  getBillBySession(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.billingService.getBillBySession(principal, sessionId);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Post('sessions/:sessionId/bill')
  generateOrRefreshBill(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: GenerateBillDto,
  ) {
    return this.billingService.generateOrRefreshBill(principal, sessionId, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Post('bills/:id/discount')
  applyAuditedDiscount(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) billId: string,
    @Body() dto: ApplyDiscountDto,
  ) {
    return this.billingService.applyAuditedDiscount(principal, billId, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER)
  @Post('bills/:id/void')
  voidBill(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) billId: string,
    @Body() dto: VoidBillDto,
  ) {
    return this.billingService.voidBill(principal, billId, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Get('bills/:id/receipt.pdf')
  async downloadReceiptPdf(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) billId: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.billingService.buildBillReceiptPdf(principal, billId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }
}

