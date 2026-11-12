import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StaffRole } from '@autonex/shared';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import {
  AuthenticatedPrincipal,
  CurrentUser,
  requireOutletContext,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CreateCategoryDto,
  ReorderCategoriesDto,
  UpdateCategoryDto,
} from './dto/category.dto';
import { CreateMenuItemDto, UpdateMenuItemDto } from './dto/menu-item.dto';
import { PresignImageDto } from './dto/presign-image.dto';
import { StockToggleDto } from './dto/stock-toggle.dto';
import { MediaService, UploadedImageInput } from './media.service';
import { MenusService } from './menus.service';

@AllowPendingTenant()
@Controller('menus')
export class MenusController {
  constructor(
    private readonly menusService: MenusService,
    private readonly mediaService: MediaService,
  ) {}

  @Roles(
    StaffRole.OWNER,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.WAITER,
    StaffRole.KITCHEN,
  )
  @Get()
  getFullMenu(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.menusService.getFullMenu(principal);
  }

  @Roles(
    StaffRole.OWNER,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.WAITER,
    StaffRole.KITCHEN,
  )
  @Get('categories')
  listCategories(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.menusService.listCategories(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post('categories')
  createCategory(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.menusService.createCategory(principal, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Patch('categories/reorder')
  reorderCategories(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: ReorderCategoriesDto,
  ) {
    return this.menusService.reorderCategories(principal, dto.categoryIds);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Patch('categories/:id')
  updateCategory(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.menusService.updateCategory(principal, id, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Delete('categories/:id')
  deleteCategory(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.menusService.deleteCategory(principal, id);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post('items')
  createMenuItem(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.menusService.createMenuItem(principal, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Patch('items/:id')
  updateMenuItem(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.menusService.updateMenuItem(principal, id, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.KITCHEN)
  @Patch('items/:id/stock')
  toggleItemStock(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StockToggleDto,
  ) {
    return this.menusService.toggleItemStock(principal, id, dto.inStock);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER, StaffRole.KITCHEN)
  @Patch('modifier-options/:id/stock')
  toggleModifierOptionStock(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StockToggleDto,
  ) {
    return this.menusService.toggleModifierOptionStock(principal, id, dto.inStock);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Delete('items/:id')
  deleteMenuItem(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.menusService.deleteMenuItem(principal, id);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post('images/presign')
  presignImage(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: PresignImageDto,
  ) {
    const ctx = requireOutletContext(principal);
    return this.mediaService.createPresignedUploadUrl(ctx.tenantId, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post('images/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  uploadImage(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @UploadedFile() file: UploadedImageInput | undefined,
  ) {
    const ctx = requireOutletContext(principal);
    return this.mediaService.uploadMenuItemImage(ctx.tenantId, file);
  }
}

