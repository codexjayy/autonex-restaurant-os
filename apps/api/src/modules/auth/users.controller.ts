import { Permissions } from '@autonex/permissions';
import type { AuthenticatedPrincipal } from '@autonex/types';
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthService } from './auth.service';
import { UpdateProfileDto } from './dto/milestone1-auth.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly authService: AuthService) {}

  @AllowPendingTenant()
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.authService.getUserMe(principalOrThrow(user));
  }

  @AllowPendingTenant()
  @RequirePermissions(Permissions.USER_READ)
  @Patch('me')
  async updateMe(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateUserMe(principalOrThrow(user), dto);
  }
}

function principalOrThrow(user: AuthenticatedPrincipal): AuthenticatedPrincipal {
  return user;
}

