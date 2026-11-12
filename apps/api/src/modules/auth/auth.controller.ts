import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StaffRole } from '@autonex/shared';
import type { Request, Response } from 'express';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthService } from './auth.service';
import { CreateStaffDto, UpdateStaffDto } from './dto/create-staff.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterRestaurantDto } from './dto/register-restaurant.dto';
import { StaffPinLoginDto } from './dto/staff-pin-login.dto';

const REFRESH_COOKIE_NAME = 'anx_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private setRefreshCookie(res: Response, refreshToken: string): void {
    const isProd = this.configService.get<string>('NODE_ENV') === 'production';
    const days = Number(this.configService.get<number>('JWT_REFRESH_TTL_DAYS') ?? 7);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: days * 24 * 60 * 60 * 1000,
    });
  }

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterRestaurantDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.registerRestaurant(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Post('staff-pin')
  async staffPinLogin(@Body() dto: StaffPinLoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.staffPinLogin(dto);
    this.setRefreshCookie(res, result.refreshToken);
    return result;
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieToken = (req.cookies as Record<string, string | undefined> | undefined)?.[
      REFRESH_COOKIE_NAME
    ];
    const token = dto.refreshToken ?? cookieToken ?? '';
    const tokens = await this.authService.refresh(token);
    this.setRefreshCookie(res, tokens.refreshToken);
    return tokens;
  }

  @Public()
  @Post('logout')
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieToken = (req.cookies as Record<string, string | undefined> | undefined)?.[
      REFRESH_COOKIE_NAME
    ];
    await this.authService.logout(dto.refreshToken ?? cookieToken);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
    return { ok: true };
  }

  @AllowPendingTenant()
  @Get('me')
  me(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.authService.getMe(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Get('staff')
  listStaff(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.authService.listStaff(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Post('staff')
  createStaff(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: CreateStaffDto) {
    return this.authService.createStaff(principal, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @Patch('staff/:membershipId')
  updateStaff(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.authService.updateStaff(principal, membershipId, dto);
  }
}

