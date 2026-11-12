import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { StaffRole } from '@autonex/shared';
import type { Response } from 'express';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateTableDto, UpdateTableDto } from './dto/table.dto';
import { TablesService } from './tables.service';

@AllowPendingTenant()
@Controller('tables')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.CASHIER, StaffRole.WAITER)
  @Get()
  listTables(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.tablesService.listTables(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post()
  createTable(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: CreateTableDto,
  ) {
    return this.tablesService.createTable(principal, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Get('qr-pdf/bulk')
  async downloadBulkQrPdf(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Res() res: Response,
  ) {
    const { filename, buffer } = await this.tablesService.getBulkTableQrPdf(principal);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Patch(':id')
  updateTable(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTableDto,
  ) {
    return this.tablesService.updateTable(principal, id, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post(':id/rotate-qr')
  rotateQrToken(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tablesService.rotateQrToken(principal, id);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post(':id/revoke-qr')
  revokeQrToken(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tablesService.revokeQrToken(principal, id);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Get(':id/qr-pdf')
  async downloadSingleQrPdf(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const { filename, buffer } = await this.tablesService.getSingleTableQrPdf(principal, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Delete(':id')
  deleteTable(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tablesService.deleteTable(principal, id);
  }
}

