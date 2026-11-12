import { Permissions } from '@autonex/permissions';
import { ErrorCode, StaffRole } from '@autonex/shared';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AllowPendingTenant } from '../../common/decorators/allow-pending-tenant.decorator';
import { AuthenticatedPrincipal, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  generateCsrfToken,
  REFRESH_COOKIE_NAME,
  safeEqualStrings,
} from '../../common/security/crypto.util';
import { AuthService } from './auth.service';
import { CreateStaffDto, UpdateStaffDto } from './dto/create-staff.dto';
import { LoginDto } from './dto/login.dto';
import {
  AcceptInvitationDto,
  CreateInvitationDto,
  SwitchOutletDto,
} from './dto/milestone1-auth.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterRestaurantDto } from './dto/register-restaurant.dto';
import { StaffPinLoginDto } from './dto/staff-pin-login.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  SuperAdminSetupDto,
} from './dto/super-admin-auth.dto';

const SA_REFRESH_COOKIE_NAME = 'anx_sa_refresh';
const SA_CSRF_COOKIE_NAME = 'anx_sa_csrf';

type CookieScope = 'tenant' | 'super-admin';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private extractMeta(req?: Request) {
    return {
      ipAddress: req?.ip ?? req?.socket?.remoteAddress,
      userAgent: req?.header('user-agent'),
    };
  }

  private cookieNames(scope: CookieScope) {
    return scope === 'super-admin'
      ? { refresh: SA_REFRESH_COOKIE_NAME, csrf: SA_CSRF_COOKIE_NAME }
      : { refresh: REFRESH_COOKIE_NAME, csrf: CSRF_COOKIE_NAME };
  }

  private setSessionCookies(res: Response, refreshToken: string, scope: CookieScope = 'tenant'): string {
    const isProd = this.configService.get<string>('NODE_ENV') === 'production';
    const days = Number(this.configService.get<number>('JWT_REFRESH_TTL_DAYS') ?? 7);
    const maxAge = days * 24 * 60 * 60 * 1000;
    const csrfToken = generateCsrfToken();
    const names = this.cookieNames(scope);

    res.cookie(names.refresh, refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge,
    });
    res.cookie(names.csrf, csrfToken, {
      httpOnly: false,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });

    return csrfToken;
  }

  private clearSessionCookies(res: Response, scope: CookieScope = 'tenant'): void {
    const names = this.cookieNames(scope);
    res.clearCookie(names.refresh, { path: '/api/v1/auth' });
    res.clearCookie(names.csrf, { path: '/' });
  }

  private assertCsrfIfCookieAuth(
    req: Request,
    bodyRefreshToken?: string,
    scope: CookieScope = 'tenant',
  ): void {
    const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
    const names = this.cookieNames(scope);
    const hasRefreshCookie = Boolean(cookies[names.refresh]);
    if (!bodyRefreshToken && hasRefreshCookie) {
      const cookieCsrf = cookies[names.csrf];
      const headerCsrf = req.header(CSRF_HEADER_NAME);
      if (!cookieCsrf || !headerCsrf || !safeEqualStrings(cookieCsrf, headerCsrf)) {
        throw new ForbiddenException({
          code: ErrorCode.CSRF_TOKEN_INVALID,
          message: 'Invalid or missing CSRF token',
        });
      }
    }
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterRestaurantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.registerRestaurant(dto, this.extractMeta(req));
    const csrfToken = this.setSessionCookies(res, result.refreshToken);
    return { ...result, csrfToken };
  }

  @Public()
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, this.extractMeta(req));
    const csrfToken = this.setSessionCookies(res, result.refreshToken);
    return { ...result, csrfToken };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('super-admin/setup-status')
  getSuperAdminSetupStatus() {
    return this.authService.getSuperAdminSetupStatus();
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('super-admin/setup')
  async setupInitialSuperAdmin(
    @Body() dto: SuperAdminSetupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.setupInitialSuperAdmin(dto, this.extractMeta(req));
    const csrfToken = this.setSessionCookies(res, result.refreshToken, 'super-admin');
    return { ...result, csrfToken };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('super-admin/login')
  async superAdminLogin(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.superAdminLogin(dto, this.extractMeta(req));
    const csrfToken = this.setSessionCookies(res, result.refreshToken, 'super-admin');
    return { ...result, csrfToken };
  }

  @Public()
  @Post('super-admin/refresh')
  async superAdminRefresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertCsrfIfCookieAuth(req, dto.refreshToken, 'super-admin');
    const cookieToken = (req.cookies as Record<string, string | undefined> | undefined)?.[
      SA_REFRESH_COOKIE_NAME
    ];
    const token = dto.refreshToken ?? cookieToken ?? '';
    const tokens = await this.authService.refresh(token, this.extractMeta(req));
    const csrfToken = this.setSessionCookies(res, tokens.refreshToken, 'super-admin');
    return { ...tokens, csrfToken };
  }

  @Public()
  @Post('super-admin/logout')
  async superAdminLogout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request & { user?: AuthenticatedPrincipal },
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertCsrfIfCookieAuth(req, dto.refreshToken, 'super-admin');
    const cookieToken = (req.cookies as Record<string, string | undefined> | undefined)?.[
      SA_REFRESH_COOKIE_NAME
    ];
    await this.authService.logout(dto.refreshToken ?? cookieToken, req.user, this.extractMeta(req));
    this.clearSessionCookies(res, 'super-admin');
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('super-admin/forgot-password')
  requestSuperAdminPasswordReset(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.authService.requestSuperAdminPasswordReset(dto, this.extractMeta(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('super-admin/reset-password')
  resetSuperAdminPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.authService.resetSuperAdminPassword(dto, this.extractMeta(req));
  }

  @Public()
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('staff-pin')
  async staffPinLogin(
    @Body() dto: StaffPinLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.staffPinLogin(dto, this.extractMeta(req));
    const csrfToken = this.setSessionCookies(res, result.refreshToken);
    return { ...result, csrfToken };
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertCsrfIfCookieAuth(req, dto.refreshToken);
    const cookieToken = (req.cookies as Record<string, string | undefined> | undefined)?.[
      REFRESH_COOKIE_NAME
    ];
    const token = dto.refreshToken ?? cookieToken ?? '';
    const tokens = await this.authService.refresh(token, this.extractMeta(req));
    const csrfToken = this.setSessionCookies(res, tokens.refreshToken);
    return { ...tokens, csrfToken };
  }

  @Public()
  @Post('logout')
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request & { user?: AuthenticatedPrincipal },
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertCsrfIfCookieAuth(req, dto.refreshToken);
    const cookieToken = (req.cookies as Record<string, string | undefined> | undefined)?.[
      REFRESH_COOKIE_NAME
    ];
    await this.authService.logout(dto.refreshToken ?? cookieToken, req.user, this.extractMeta(req));
    this.clearSessionCookies(res);
    return { ok: true };
  }

  @AllowPendingTenant()
  @Post('switch-outlet')
  async switchOutlet(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: SwitchOutletDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.switchOutlet(
      principal,
      dto.outletId,
      this.extractMeta(req),
    );
    const csrfToken = this.setSessionCookies(res, result.refreshToken);
    return { ...result, csrfToken };
  }

  @AllowPendingTenant()
  @Get('me')
  me(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.authService.getMe(principal);
  }

  @AllowPendingTenant()
  @Get('sessions')
  listSessions(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.authService.listSessions(principal);
  }

  @AllowPendingTenant()
  @Post('sessions/:sessionId/revoke')
  revokeSession(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ) {
    return this.authService.revokeSession(principal, sessionId);
  }

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @RequirePermissions(Permissions.STAFF_READ)
  @Get('staff')
  listStaff(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.authService.listStaff(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @RequirePermissions(Permissions.STAFF_MANAGE)
  @Post('staff')
  createStaff(@CurrentUser() principal: AuthenticatedPrincipal, @Body() dto: CreateStaffDto) {
    return this.authService.createStaff(principal, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @RequirePermissions(Permissions.STAFF_MANAGE)
  @Patch('staff/:membershipId')
  updateStaff(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.authService.updateStaff(principal, membershipId, dto);
  }

  @AllowPendingTenant()
  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @RequirePermissions(Permissions.INVITATION_MANAGE)
  @Get('invitations')
  listInvitations(@CurrentUser() principal: AuthenticatedPrincipal) {
    return this.authService.listInvitations(principal);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @RequirePermissions(Permissions.INVITATION_MANAGE)
  @Post('invitations')
  createInvitation(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body() dto: CreateInvitationDto,
  ) {
    return this.authService.createInvitation(principal, dto);
  }

  @Roles(StaffRole.OWNER, StaffRole.MANAGER)
  @RequirePermissions(Permissions.INVITATION_MANAGE)
  @Post('invitations/:invitationId/revoke')
  revokeInvitation(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('invitationId', new ParseUUIDPipe()) invitationId: string,
  ) {
    return this.authService.revokeInvitation(principal, invitationId);
  }

  @Public()
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('invitations/accept')
  async acceptInvitation(
    @Body() dto: AcceptInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.acceptInvitation(dto, this.extractMeta(req));
    const csrfToken = this.setSessionCookies(res, result.refreshToken);
    return { ...result, csrfToken };
  }
}
